/**
 * The Control Skills: the eight skills that let an agent operate Nexus.
 *
 * They ship with Nexus, and their Owner is the Nexus home
 * (`<Nexus home>/skills/<name>`). Their names are reserved: no Installed or
 * Custom Skill may take one. The order is the Bash CLI's (`CONTROL_SKILLS`),
 * which Bootstrap links in.
 */
import { join } from 'node:path';
import type { Paths } from './paths.ts';
import { skillNameKey } from './skill-names.ts';

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

/**
 * True when `name` is the name of a Control Skill, or on Windows, which
 * ignores case, the same name in another case.
 */
export function isControlSkill(name: string): boolean {
  return CONTROL_SKILLS.some((control) => skillNameKey(control) === skillNameKey(name));
}

/** The Owner directory of one Control Skill. */
export function controlSkillTarget(paths: Paths, name: string): string {
  return join(paths.controlRoot, name);
}
