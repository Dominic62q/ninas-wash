import { useQuery } from '@tanstack/react-query';
import { isWithin, type RoleDto } from '@niinas/shared';
import { api } from './api';
import { useAuth } from './auth';

export const ROLES_KEY = ['roles'] as const;

/** Every role, for the user form and the Roles screen. Only people who can add users or change passwords may read it. */
export function useRoles() {
  const { can } = useAuth();
  return useQuery({
    queryKey: ROLES_KEY,
    queryFn: () => api<{ roles: RoleDto[] }>('/roles'),
    enabled: can('user.manage') || can('user.reset_password') || can('role.manage'),
    select: (d) => d.roles,
  });
}

/** The roles this person may hand to someone else: nothing that does more than they can do themselves. */
export function useAssignableRoles() {
  const { permissions } = useAuth();
  const roles = useRoles();
  return { ...roles, assignable: (roles.data ?? []).filter((r) => isWithin(r.permissions, permissions)) };
}
