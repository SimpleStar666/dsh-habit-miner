/**
 * dsh-habit-miner — host entry.
 *
 * The bundle's `dsh.bundle.patch` inserts one row whose `name` resolves to this
 * package; DSH then imports the package root and calls `apply(ctx, config)`.
 */

export { apply, Config, inject, name } from './src/plugin.mjs';
