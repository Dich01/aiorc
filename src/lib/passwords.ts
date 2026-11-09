// Password policy shared by registration and the admin:create script.
export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 200; // bcrypt only reads 72 bytes; this just bounds the work

// Returns an error message, or null when the password is acceptable.
export function validatePassword(password: unknown): string | null {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    return `password must be at least ${MIN_PASSWORD_LENGTH} characters`;
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    return `password must be at most ${MAX_PASSWORD_LENGTH} characters`;
  }
  return null;
}
