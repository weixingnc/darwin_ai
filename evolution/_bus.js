/**
 * Evolution-local EventBus singleton.
 *
 * Why a separate file: core/event-bus.js exports the `EventBus` CLASS only
 * (per PR-4 / PR-23 contract — modules own their bus instance, no global
 * singleton). The evolution module needs a shared bus across diagnose /
 * propose / apply / verify / rollback so event subscribers can span the
 * pipeline. This file creates and exports that shared instance.
 *
 * PR-S2 will likely wire this into the framework container (PR-4) so the
 * whole Darwin process shares one bus. Until then, this is fine.
 */

import { EventBus } from '../core/event-bus.js';

export const evolutionBus = new EventBus({ maxListeners: 50 });
