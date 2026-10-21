/** `unreachable`: the server couldn't be asked — never treated as signed out. */
export type AuthStatus = 'unknown' | 'authenticated' | 'anonymous' | 'unreachable';
