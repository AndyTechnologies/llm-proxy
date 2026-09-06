/**
 * Svelte 5 UI entry (svelte-ui task 3.3).
 *
 * Phase 2 left a styles-only placeholder so the build pipeline was real;
 * Phase 3 replaces it: App.svelte owns the shell + five views and mounts
 * here into `#app`. Everything else (stores, SSE, routing) is composed
 * inside App with injectable factories.
 */
import { mount } from "svelte";
import App from "./App.svelte";
import "./styles.css";

mount(App, { target: document.getElementById("app")! });