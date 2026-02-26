/**
 * Type-safe wrapper around Response.json().
 *
 * Avoids `any` from the default Response.json() return type,
 * which triggers no-unsafe-assignment / no-unsafe-member-access.
 */
export async function jsonBody<T>(resp: Response): Promise<T> {
  return (await resp.json()) as T;
}
