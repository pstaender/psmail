import { useEffect, useState } from "react";
import { api } from "../lib/api";
import type { EmailRecord } from "../server/types";
import { useAuth } from "../contexts/AuthContext";

export function useEmailDetail(accountEmail: string | null, emailId: number | null) {
  const { token } = useAuth();
  const [email, setEmail] = useState<EmailRecord | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!token || !accountEmail || emailId === null) {
      setEmail(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    api
      .getEmail(token, accountEmail, emailId)
      .then(result => {
        if (!cancelled) setEmail(result);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [token, accountEmail, emailId]);

  return { email, loading, setEmail };
}
