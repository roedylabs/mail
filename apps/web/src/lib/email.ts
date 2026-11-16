/** Email address, as checked by `auth::email` in the backend. */
const EM = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function isEmail(value: string): boolean {
  return EM.test(value);
}
