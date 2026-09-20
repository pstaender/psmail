import { useCallback, useEffect, useState } from "react";
import { Loader2, Pencil, Plus, Trash2, Zap } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { api, type UserSettings } from "@/lib/api";
import { useAuth } from "@/contexts/AuthContext";
import { AI_CATEGORIES, AI_VENDORS, SKILL_DEFAULTS, VENDOR_LABELS, defaultApiLabel, type AiCategory, type AiVendor } from "../../ai/categories";
import type { AiApiRecord, AiSkillRecord } from "../../server/models/ai";

const MODEL_EXAMPLES: Record<AiVendor, string> = {
  anthropic: "e.g. claude-opus-5",
  openai: "e.g. gpt-5",
  google: "e.g. gemini-2.5-pro",
  ollama: "e.g. llama3.1",
};

/** 1234 -> "1.2k", 2_500_000 -> "2.5M": token totals get big fast. */
export function formatTokens(count: number): string {
  if (count < 1000) return String(count);
  if (count < 1_000_000) return `${(count / 1000).toFixed(count < 10_000 ? 1 : 0).replace(/\.0$/, "")}k`;
  return `${(count / 1_000_000).toFixed(count < 10_000_000 ? 1 : 0).replace(/\.0$/, "")}M`;
}

const SELECT_CLASS = "h-9 w-full rounded-md border border-input bg-transparent px-2 text-sm";

interface ApiForm {
  id: number | null;
  name: string;
  vendor: AiVendor;
  model: string;
  baseUrl: string;
  apiKey: string;
  hadKey: boolean;
}

interface SkillForm {
  id: number | null;
  category: AiCategory;
  name: string;
  aiApiId: number;
  prompt: string;
}

/**
 * Settings → AI: the AI providers (vendor + model + API key) the user has set up, the skills (a category with
 * a prompt, run through one provider) built on them, and the language translations go into. Changes are saved
 * right away, one item at a time; `onChanged` tells the app which skills exist so it can enable the buttons.
 */
export function AiSettings({
  settings,
  onSaveLanguage,
  onChanged,
}: {
  settings: UserSettings;
  onSaveLanguage: (language: string | null) => Promise<void>;
  onChanged: () => void;
}) {
  const { token } = useAuth();
  const [apis, setApis] = useState<AiApiRecord[] | null>(null);
  const [skills, setSkills] = useState<AiSkillRecord[]>([]);
  const [apiForm, setApiForm] = useState<ApiForm | null>(null);
  const [skillForm, setSkillForm] = useState<SkillForm | null>(null);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [language, setLanguage] = useState(settings.aiTargetLanguage ?? "");

  const load = useCallback(async () => {
    if (!token) return;
    try {
      const [loadedApis, loadedSkills] = await Promise.all([api.listAiApis(token), api.listAiSkills(token)]);
      setApis(loadedApis);
      setSkills(loadedSkills);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [token]);

  useEffect(() => {
    load();
  }, [load]);

  const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

  async function saveApi(e: React.FormEvent) {
    e.preventDefault();
    if (!token || !apiForm) return;
    setBusy(true);
    setError(null);
    try {
      const input = {
        name: apiForm.name,
        vendor: apiForm.vendor,
        model: apiForm.model,
        baseUrl: apiForm.baseUrl.trim() || null,
        // Editing: an empty field keeps the stored key.
        ...(apiForm.apiKey.trim() ? { apiKey: apiForm.apiKey } : {}),
      };
      if (apiForm.id === null) await api.createAiApi(token, input);
      else await api.updateAiApi(token, apiForm.id, input);
      setApiForm(null);
      await load();
      onChanged();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }

  async function removeApi(record: AiApiRecord) {
    if (!token) return;
    const affected = skills.filter(s => s.aiApiId === record.id).length;
    const warning = affected > 0 ? `\n\nThe ${affected} skill${affected === 1 ? "" : "s"} using it will be deleted too.` : "";
    if (!window.confirm(`Delete the AI provider "${record.label}"?${warning}`)) return;
    try {
      await api.deleteAiApi(token, record.id);
      await load();
      onChanged();
    } catch (err) {
      setError(message(err));
    }
  }

  async function testApi(record: AiApiRecord) {
    if (!token) return;
    setTesting(record.id);
    try {
      const result = await api.testAiApi(token, record.id);
      toast.success(`${record.label} works — it answered "${result.answer}".`);
    } catch (err) {
      toast.error(message(err));
    } finally {
      setTesting(null);
    }
  }

  async function saveSkill(e: React.FormEvent) {
    e.preventDefault();
    if (!token || !skillForm) return;
    setBusy(true);
    setError(null);
    try {
      const input = { category: skillForm.category, name: skillForm.name, aiApiId: skillForm.aiApiId, prompt: skillForm.prompt };
      if (skillForm.id === null) await api.createAiSkill(token, input);
      else await api.updateAiSkill(token, skillForm.id, input);
      setSkillForm(null);
      await load();
      onChanged();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }

  async function removeSkill(skill: AiSkillRecord) {
    if (!token || !window.confirm(`Delete the skill "${skill.name}"?`)) return;
    try {
      await api.deleteAiSkill(token, skill.id);
      await load();
      onChanged();
    } catch (err) {
      setError(message(err));
    }
  }

  function newSkillForm(): SkillForm {
    const category: AiCategory = AI_CATEGORIES.find(c => !skills.some(s => s.category === c)) ?? "summarize";
    return { id: null, category, name: SKILL_DEFAULTS[category].label, aiApiId: apis![0]!.id, prompt: SKILL_DEFAULTS[category].prompt };
  }

  /** Picking a category suggests its prompt (and name) — unless the user already changed those by hand. */
  function changeCategory(category: AiCategory) {
    setSkillForm(form => {
      if (!form) return form;
      const old = SKILL_DEFAULTS[form.category];
      return {
        ...form,
        category,
        name: form.name === old.label || form.name === "" ? SKILL_DEFAULTS[category].label : form.name,
        prompt: form.prompt === old.prompt || form.prompt.trim() === "" ? SKILL_DEFAULTS[category].prompt : form.prompt,
      };
    });
  }

  /** What a provider without a name is called: Vendor.model. */
  const apiDefaultLabel = (form: ApiForm) => defaultApiLabel(form.vendor, form.model.trim() || "model");
  const apiName = (id: number) => apis?.find(a => a.id === id)?.label ?? "?";

  return (
    <div className="space-y-6">
      {error && <p className="text-sm text-destructive">{error}</p>}
      <p className="rounded-md bg-muted/50 p-2 text-xs text-muted-foreground">
        AI skills send the text of the message (or of your draft) to the AI provider you choose here — only when you press
        the matching button. API keys are stored encrypted, like your mail account passwords.
      </p>

      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">AI providers</h3>
          {!apiForm && (
            <Button type="button" size="sm" variant="outline" onClick={() => setApiForm({ id: null, name: "", vendor: "anthropic", model: "", baseUrl: "", apiKey: "", hadKey: false })}>
              <Plus className="size-3.5" /> Add provider
            </Button>
          )}
        </div>

        {apis === null && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
        {apis?.length === 0 && !apiForm && <p className="text-xs text-muted-foreground">No provider yet. Add one to create skills.</p>}
        <ul className="space-y-1.5">
          {apis?.map(record => (
            <li key={record.id} className="flex items-center gap-2 rounded-md border p-2 text-sm">
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{record.label}</div>
                <div className="truncate text-xs text-muted-foreground">
                  {VENDOR_LABELS[record.vendor]} · {record.model}
                  {record.baseUrl ? ` · ${record.baseUrl}` : ""}
                  {record.hasKey ? " · key saved" : ""}
                </div>
                <div className="truncate text-xs text-muted-foreground" title={`${record.inputTokens.toLocaleString("en-US")} tokens in, ${record.outputTokens.toLocaleString("en-US")} tokens out`}>
                  {record.calls > 0
                    ? `${record.calls} call${record.calls === 1 ? "" : "s"} · ${formatTokens(record.inputTokens)} tokens in · ${formatTokens(record.outputTokens)} out`
                    : "Not used yet"}
                </div>
              </div>
              <Button type="button" variant="ghost" size="sm" title={`Test ${record.label}`} disabled={testing === record.id} onClick={() => testApi(record)}>
                {testing === record.id ? <Loader2 className="size-3.5 animate-spin" /> : <Zap className="size-3.5" />}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                title={`Edit ${record.label}`}
                onClick={() => setApiForm({ id: record.id, name: record.name, vendor: record.vendor, model: record.model, baseUrl: record.baseUrl ?? "", apiKey: "", hadKey: record.hasKey })}
              >
                <Pencil className="size-3.5" />
              </Button>
              <Button type="button" variant="ghost" size="sm" title={`Delete ${record.label}`} onClick={() => removeApi(record)}>
                <Trash2 className="size-3.5" />
              </Button>
            </li>
          ))}
        </ul>

        {apiForm && (
          <form onSubmit={saveApi} noValidate className="space-y-3 rounded-md border p-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="ai-api-vendor">Vendor</Label>
                <select id="ai-api-vendor" className={SELECT_CLASS} value={apiForm.vendor} onChange={e => setApiForm({ ...apiForm, vendor: e.target.value as AiVendor })}>
                  {AI_VENDORS.map(vendor => (
                    <option key={vendor} value={vendor}>
                      {VENDOR_LABELS[vendor]}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ai-api-model">Model</Label>
                <Input id="ai-api-model" placeholder={MODEL_EXAMPLES[apiForm.vendor]} value={apiForm.model} onChange={e => setApiForm({ ...apiForm, model: e.target.value })} />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ai-api-key">API key{apiForm.vendor === "ollama" ? " (optional)" : ""}</Label>
              <Input
                id="ai-api-key"
                type="password"
                autoComplete="off"
                placeholder={apiForm.hadKey ? "Saved — leave empty to keep it" : ""}
                value={apiForm.apiKey}
                onChange={e => setApiForm({ ...apiForm, apiKey: e.target.value })}
              />
            </div>
            {(apiForm.vendor === "ollama" || apiForm.vendor === "openai") && (
              <div className="space-y-1.5">
                <Label htmlFor="ai-api-url">Address (optional)</Label>
                <Input
                  id="ai-api-url"
                  placeholder={apiForm.vendor === "ollama" ? "http://localhost:11434" : "https://api.openai.com/v1 — or another OpenAI-compatible service"}
                  value={apiForm.baseUrl}
                  onChange={e => setApiForm({ ...apiForm, baseUrl: e.target.value })}
                />
              </div>
            )}
            <div className="space-y-1.5">
              <Label htmlFor="ai-api-name">Name (optional)</Label>
              <Input
                id="ai-api-name"
                placeholder={apiDefaultLabel(apiForm)}
                value={apiForm.name}
                onChange={e => setApiForm({ ...apiForm, name: e.target.value })}
              />
              <p className="text-xs text-muted-foreground">Empty: {apiDefaultLabel(apiForm)}.</p>
            </div>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" size="sm" onClick={() => setApiForm(null)}>
                Cancel
              </Button>
              <Button type="submit" size="sm" disabled={busy}>
                {busy && <Loader2 className="size-3.5 animate-spin" />}
                Save provider
              </Button>
            </div>
          </form>
        )}
      </section>

      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">Skills</h3>
          {!skillForm && (
            <Button type="button" size="sm" variant="outline" disabled={!apis || apis.length === 0} title={apis?.length ? undefined : "Add a provider first"} onClick={() => setSkillForm(newSkillForm())}>
              <Plus className="size-3.5" /> Add skill
            </Button>
          )}
        </div>

        {skills.length === 0 && !skillForm && (
          <p className="text-xs text-muted-foreground">
            A skill is a prompt for one job — summarize, categorize, find dates and events, translate, fix spelling and grammar, or improve wording — run through one of your providers.
          </p>
        )}
        <ul className="space-y-1.5">
          {skills.map(skill => (
            <li key={skill.id} className="flex items-center gap-2 rounded-md border p-2 text-sm">
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{skill.name}</div>
                <div className="truncate text-xs text-muted-foreground">
                  {SKILL_DEFAULTS[skill.category].label} · {apiName(skill.aiApiId)}
                </div>
              </div>
              <Button type="button" variant="ghost" size="sm" title={`Edit ${skill.name}`} onClick={() => setSkillForm({ id: skill.id, category: skill.category, name: skill.name, aiApiId: skill.aiApiId, prompt: skill.prompt })}>
                <Pencil className="size-3.5" />
              </Button>
              <Button type="button" variant="ghost" size="sm" title={`Delete ${skill.name}`} onClick={() => removeSkill(skill)}>
                <Trash2 className="size-3.5" />
              </Button>
            </li>
          ))}
        </ul>

        {skillForm && (
          <form onSubmit={saveSkill} noValidate className="space-y-3 rounded-md border p-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="ai-skill-category">Category</Label>
                <select id="ai-skill-category" className={SELECT_CLASS} value={skillForm.category} onChange={e => changeCategory(e.target.value as AiCategory)}>
                  {AI_CATEGORIES.map(category => (
                    <option key={category} value={category}>
                      {SKILL_DEFAULTS[category].label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ai-skill-api">AI provider</Label>
                <select id="ai-skill-api" className={SELECT_CLASS} value={skillForm.aiApiId} onChange={e => setSkillForm({ ...skillForm, aiApiId: Number(e.target.value) })}>
                  {apis?.map(record => (
                    <option key={record.id} value={record.id}>
                      {record.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <p className="text-xs text-muted-foreground">{SKILL_DEFAULTS[skillForm.category].description}</p>
            <div className="space-y-1.5">
              <Label htmlFor="ai-skill-name">Name</Label>
              <Input id="ai-skill-name" value={skillForm.name} onChange={e => setSkillForm({ ...skillForm, name: e.target.value })} />
            </div>
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label htmlFor="ai-skill-prompt">Instruction (prompt)</Label>
                <Button type="button" variant="link" size="sm" className="h-auto p-0 text-xs" onClick={() => setSkillForm({ ...skillForm, prompt: SKILL_DEFAULTS[skillForm.category].prompt })}>
                  Use suggested prompt
                </Button>
              </div>
              <Textarea id="ai-skill-prompt" rows={6} value={skillForm.prompt} onChange={e => setSkillForm({ ...skillForm, prompt: e.target.value })} />
              {skillForm.category === "translate" && <p className="text-xs text-muted-foreground">{"{{language}}"} is replaced by the language you translate into.</p>}
            </div>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" size="sm" onClick={() => setSkillForm(null)}>
                Cancel
              </Button>
              <Button type="submit" size="sm" disabled={busy}>
                {busy && <Loader2 className="size-3.5 animate-spin" />}
                Save skill
              </Button>
            </div>
          </form>
        )}
      </section>

      <section className="space-y-2">
        <h3 className="text-sm font-semibold">Translate into</h3>
        <div className="flex items-center gap-2">
          <Input
            aria-label="Translation language"
            className="max-w-48"
            placeholder="English"
            value={language}
            onChange={e => setLanguage(e.target.value)}
            onBlur={() => {
              const next = language.trim();
              if (next !== (settings.aiTargetLanguage ?? "")) onSaveLanguage(next || null).catch(err => setError(message(err)));
            }}
          />
          <span className="text-xs text-muted-foreground">The language the Translate button uses for messages.</span>
        </div>
      </section>
    </div>
  );
}
