export type { AuthConfig, PrincipalVerdict } from './principal.js';
export { extractPrincipal, ROLE_HEADER, resolvePrincipal, USER_HEADER } from './principal.js';
export type { GuardedSystem, ToolEntry } from './registry.js';
export { allowedToolEntries, assertUniqueToolNames, toRawShape } from './registry.js';
export type { FoundryServerOptions, SystemBinding } from './server.js';
export { createFoundryServer } from './server.js';
export type { IdentityClaims, TokenVerdict } from './token.js';
export { mintIdentityToken, verifyIdentityToken } from './token.js';
