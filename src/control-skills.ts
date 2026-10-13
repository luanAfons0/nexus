/**
 * The Control Skills: the eight skills that let an agent operate Nexus.
 *
 * They ship with Nexus, and their Owner is the Nexus home
 * (`<Nexus home>/skills/<name>`). Their names are reserved: no Installed or
 * Custom Skill may take one. The order is the Bash CLI's (`CONTROL_SKILLS` in
 * `scripts/lib/common.sh`), which Bootstrap links in.
 */
import { join } from 'node:path';
import type { Paths } from './paths.ts';

/** Every Control Skill, in the order Bootstrap links them. */
export const CONTROL_SKILLS: readonly string[] = [
  'nexus-setup',
  'nexus-link',
  'nexus-install',
  'nexus-new',
  'nexus-help',
  'nexus-update',
  'nexus-remove',
  'nexus',
];

/** True when `name` is the name of a Control Skill. */
export function isControlSkill(name: string): boolean {
  return CONTROL_SKILLS.includes(name);
}

/** The Owner directory of one Control Skill. */
export function controlSkillTarget(paths: Paths, name: string): string {
  return join(paths.controlRoot, name);
}
