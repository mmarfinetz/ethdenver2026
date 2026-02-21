export function supportsInlineImages(): boolean {
  const term = process.env.TERM_PROGRAM ?? "";
  return term === "iTerm.app" || term === "WezTerm";
}
