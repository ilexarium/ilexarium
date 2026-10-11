/** What login and password change need to verify a password. Never returned by the API. */
export interface UserCredentials {
  id: string;
  username: string;
  passwordHash: string;
}
