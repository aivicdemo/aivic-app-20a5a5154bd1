export type Role = 'admin' | 'operator' | 'viewer';

export interface User {
  id: string;
  role: Role;
  permissions: string[];
}

export const ROLE_PERMISSIONS: Record<Role, string[]> = {
  admin: ['*'],
  operator: [
    'resources:read',
    'resources:write',
    'users:read',
    'files:read',
    'files:write',
    'translations:read',
    'translations:write',
    'bulk:write'
  ],
  viewer: [
    'resources:read',
    'users:read',
    'files:read',
    'translations:read'
  ]
};

export function hasPermission(user: User, permission: string): boolean {
  if (!user || !user.role) return false;
  
  const rolePermissions = ROLE_PERMISSIONS[user.role] || [];
  
  if (rolePermissions.includes('*')) return true;
  
  return rolePermissions.includes(permission);
}

export function checkPermission(user: User, permission: string): void {
  if (!hasPermission(user, permission)) {
    throw new Error(`Insufficient permissions. Required: ${permission}`);
  }
}

export function getUserFromEvent(event: any): User {
  const authHeader = event.headers?.Authorization || event.headers?.authorization;
  if (!authHeader) {
    throw new Error('No authorization header');
  }
  
  try {
    const token = authHeader.replace('Bearer ', '');
    const decoded = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
    
    return {
      id: decoded.sub || decoded.userId,
      role: decoded.role || 'viewer',
      permissions: ROLE_PERMISSIONS[decoded.role || 'viewer']
    };
  } catch (error) {
    throw new Error('Invalid token');
  }
}