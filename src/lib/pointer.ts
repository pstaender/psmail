/** True on devices whose primary pointer is precise (a mouse or trackpad) — where keyboard list navigation makes sense. Assumed when the browser can't tell. */
export function hasFinePointer(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return true;
  return window.matchMedia("(pointer: fine)").matches;
}
