<script lang="ts">
  import type { IconName } from "../../lib/navigation.js";
  import Icon from "./Icon.svelte";

  let {
    name,
    label,
    size = 16,
    disabled = false,
    class: className = "",
    onclick,
  }: {
    name: IconName;
    label: string;
    size?: number;
    disabled?: boolean;
    class?: string;
    onclick?: (event: MouseEvent) => void;
  } = $props();
</script>

<button
  type="button"
  class={`icon-button ${className}`}
  aria-label={label}
  title={label}
  disabled={disabled}
  {onclick}
>
  <Icon {name} {size} />
</button>

<style>
  .icon-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 36px;
    height: 36px;
    border: 1px solid transparent;
    border-radius: var(--radius-control);
    background: transparent;
    color: var(--secondary);
    cursor: pointer;
    transition:
      color 150ms ease,
      background-color 150ms ease,
      border-color 150ms ease;
  }

  .icon-button:hover:not(:disabled) {
    color: var(--text);
    background: var(--accent-subtle);
    border-color: var(--border);
  }

  .icon-button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
</style>