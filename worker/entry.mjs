/**
 * The Worker's entry module. The runtime treats every export of the entry
 * as an entrypoint, and workerd (wrangler 4.138) refuses one that is not a
 * handler or a class, such as worker.mjs's DAEMON_CODE string. So the entry
 * exports only the fetch handler and the Durable Object class; worker.mjs
 * keeps its other exports for the tests and the sync scripts.
 */
export { default, AiRadioChannel } from "./worker.mjs";
