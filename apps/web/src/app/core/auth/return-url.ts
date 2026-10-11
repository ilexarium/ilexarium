/**
 * The path to go back to after signing in. Only internal paths are accepted (a single leading
 * `/`), so a crafted `?returnUrl=` can't send the user to another site (open redirect).
 */
export function safeReturnUrl(value: string | null | undefined): string {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) {
    return '/';
  }
  return value;
}
