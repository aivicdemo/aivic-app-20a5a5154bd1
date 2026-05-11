export type Role = 'admin' | 'operator' | 'viewer';

export interface User {
  id: string;
  role: Role;
  permissions: string[];
}

export const ROLE_PERMISSIONS: Record<Role, string[]> = {
  admin: [
    'users:read', 'users:write', 'users:delete',
    'files:read', 'files:write', 'files:delete',
    'translations:read', 'translations:write', 'translations:delete',
    'formats:read', 'formats:write', 'formats:delete',
    'engines:read', 'engines:write', 'engines:delete',
    'history:read', 'history:write', 'history:delete',
    'errors:read', 'errors:write', 'errors:delete',
    'settings:read', 'settings:write', 'settings:delete',
    'evaluations:read', 'evaluations:write', 'evaluations:delete',
    'bulk:import'
  ],
  operator: [
    'users:read',
    'files:read', 'files:write',
    'translations:read', 'translations:write',
    'formats:read',
    'engines:read',
    'history:read', 'history:write',
    'errors:read',
    'settings:read',
    'evaluations:read', 'evaluations:write',
    'bulk:import'
  ],
  viewer: [
    'users:read',
    'files:read',
    'translations:read',
    'formats:read',
    'engines:read',
    'history:read',
    'errors:read',
    'settings:read',
    'evaluations:read'
  ]
};

export function hasPermission(user: User, permission: string): boolean {
  return user.permissions.includes(permission) || ROLE_PERMISSIONS[user.role].includes(permission);
}

export function checkPermission(user: User, permission: string): void {
  if (!hasPermission(user, permission)) {
    throw new Error(`Insufficient permissions. Required: ${permission}`);
  }
}