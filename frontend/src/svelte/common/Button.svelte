<script lang="ts">
  import type { Snippet } from "svelte";

  const BUTTON_VARIANTS = {
    primary: "primary",
    secondary: "secondary",
    ghost: "ghost",
  } as const;

  type ButtonVariant = (typeof BUTTON_VARIANTS)[keyof typeof BUTTON_VARIANTS];

  let {
    variant = "secondary",
    type = "button",
    disabled = false,
    class: className = "",
    ariaLabel,
    onclick,
    children,
  }: {
    variant?: ButtonVariant;
    type?: "button" | "submit" | "reset";
    disabled?: boolean;
    class?: string;
    ariaLabel?: string;
    onclick?: (event: MouseEvent) => void;
    children: Snippet;
  } = $props();
</script>

<button
  type={type}
  class={`btn btn-${variant} ${className}`}
  disabled={disabled}
  aria-label={ariaLabel}
  {onclick}
>
  {@render children()}
</button>

<style>
  .btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: var(--space-2);
    min-height: 36px;
    padding: var(--space-2) var(--space-4);
    border: 1px solid var(--border);
    border-radius: var(--radius-control);
    background: var(--card);
    color: var(--text);
    font: inherit;
    font-size: 0.875rem;
    font-weight: 600;
    line-height: 1.2;
    cursor: pointer;
    transition:
      border-color 150ms ease,
      background-color 150ms ease,
      color 150ms ease;
  }

  .btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .btn-primary {
    background: var(--accent);
    border-color: var(--accent);
    color: #ffffff;
  }

  .btn-primary:hover:not(:disabled) {
    background: var(--accent-hover);
    border-color: var(--accent-hover);
  }

  .btn-secondary:hover:not(:disabled) {
    border-color: var(--border-hover);
    background: var(--accent-subtle);
  }

  .btn-ghost {
    background: transparent;
    border-color: transparent;
    color: var(--secondary);
  }

  .btn-ghost:hover:not(:disabled) {
    color: var(--text);
    background: var(--accent-subtle);
  }
</style>