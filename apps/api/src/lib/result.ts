/**
 * ============================================================================
 * Service Error Types
 * ============================================================================
 *
 * Shared error type for the service layer. Services return
 * Result<T, ServiceError> using @praha/byethrow.
 */

export type ServiceError = {
  message: string;
  code: "NOT_FOUND" | "NOT_AUTHORIZED" | "INVALID";
};
