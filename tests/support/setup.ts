/**
 * Global test setup.
 *
 * React 18 only routes `act()` through its batched queue when this flag is set;
 * without it every render test prints a warning and state updates inside click
 * handlers are not flushed deterministically. It is a plain global, so setting
 * it for the node-environment tests too is harmless.
 */

export {}

declare global {
  interface GlobalThis {
    IS_REACT_ACT_ENVIRONMENT?: boolean
  }
}

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
