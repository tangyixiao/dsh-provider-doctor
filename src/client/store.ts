/**
 * The panel's own state machine, kept out of React so the transitions can be
 * tested without a renderer.
 *
 * The interesting part is not "loading or not": it is that a run can end in
 * three different ways the UI must distinguish — a snapshot arrived, a run was
 * cancelled, or the Host refused/could not answer. A store that collapsed those
 * into "no data" would make a 403 look like "not checked yet", which is exactly
 * the confusion this plugin exists to remove.
 *
 * Every request carries its own `AbortSignal`, and every result is dropped when
 * that signal has fired, so a superseded run can never overwrite a newer one.
 *
 * @module dsh-provider-doctor/client/store
 */

import type { ShareableReport } from '../shared/contract.ts'
import type { DoctorSnapshot, StatusResponse } from '../shared/snapshot.ts'
import { fetchShareable, fetchStatus, runBasic, runConnection, type ApiFailure } from './api.ts'

/** What the panel is doing right now. */
export type Phase =
  /** Nothing has been read or run yet. */
  | 'idle'
  /** A run is in flight. */
  | 'running'
  /** A snapshot is available. */
  | 'ready'
  /** The last attempt failed before producing a snapshot. */
  | 'failed'

/** Everything the panel renders from. */
export interface PanelState {
  phase: Phase
  /** The last snapshot that arrived, if any. */
  snapshot?: DoctorSnapshot
  /** Why the last attempt failed, if it did. */
  failure?: ApiFailure
  /** Whether {@link snapshot} came from a status read rather than a run. */
  cached: boolean
}

/** The subset of the store the panel subscribes to. */
export interface PanelStore {
  getSnapshot(): PanelState
  subscribe(listener: () => void): () => void
  /** Read the Host's cached snapshot. Does not run a check. */
  load(): Promise<void>
  /** Run the offline checks. */
  diagnose(): Promise<void>
  /** Run the offline checks and the side-effecting connection check. */
  connect(): Promise<void>
  /** Abort the request in flight, if any, and settle the panel honestly. */
  cancel(): Promise<void>
  /** Fetch the redacted document for the last run. */
  share(): Promise<ShareableReport | undefined>
  /** Stop listening and abort whatever is in flight. Safe to call more than once. */
  dispose(): void
}

const IDLE: PanelState = { phase: 'idle', cached: false }

/**
 * Build the panel store.
 *
 * @returns A store the panel hooks into with `useSyncExternalStore`.
 */
export function createPanelStore(): PanelStore {
  let state: PanelState = IDLE
  const listeners = new Set<() => void>()
  let controller: AbortController | undefined

  const emit = (next: PanelState): void => {
    state = next
    for (const listener of [...listeners]) listener()
  }

  /** Start a request, superseding any earlier one. */
  const begin = (): AbortSignal => {
    controller?.abort()
    controller = new AbortController()
    // Keep whatever the panel is already showing: a refresh must not blank the
    // page while it runs, and a cancelled refresh must be able to come back.
    emit({ ...state, phase: 'running' })
    return controller.signal
  }

  /** A status read answers with a snapshot or an explicit empty state. */
  const applyStatus = (body: StatusResponse): void => {
    if (body.empty) {
      emit({ phase: 'idle', cached: false })
      return
    }
    emit({ phase: 'ready', snapshot: body, cached: true })
  }

  /** Applied on every path: drop results whose run was superseded or cancelled. */
  const stale = (signal: AbortSignal): boolean => signal.aborted

  /**
   * Record a failure without discarding what the panel already shows.
   *
   * A failed refresh is not evidence that the previous snapshot was wrong, so
   * the snapshot stays; the failure is shown above it.
   */
  const fail = (failure: ApiFailure): void => {
    emit({ ...state, phase: 'failed', failure })
  }

  return {
    getSnapshot() {
      return state
    },

    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },

    async load() {
      const signal = begin()
      const result = await fetchStatus(signal)
      if (stale(signal)) return
      if (result.ok) applyStatus(result.value)
      else fail(result.failure)
    },

    async diagnose() {
      const signal = begin()
      const result = await runBasic(signal)
      if (stale(signal)) return
      if (result.ok) emit({ phase: 'ready', snapshot: result.value, cached: false })
      else fail(result.failure)
    },

    async connect() {
      const signal = begin()
      const result = await runConnection(signal)
      if (stale(signal)) return
      if (result.ok) emit({ phase: 'ready', snapshot: result.value, cached: false })
      else fail(result.failure)
    },

    async cancel() {
      controller?.abort()
      controller = undefined
      // The aborted request returns early instead of emitting, which would
      // otherwise leave the panel in `running` forever when the Host never
      // answers. Settling it here is what keeps the button honest.
      if (state.phase === 'running') {
        emit(
          state.snapshot === undefined
            ? { phase: 'idle', cached: false }
            : { phase: 'ready', snapshot: state.snapshot, cached: state.cached },
        )
      }
    },

    async share() {
      const result = await fetchShareable()
      return result.ok ? result.value : undefined
    },

    dispose() {
      controller?.abort()
      controller = undefined
      listeners.clear()
    },
  }
}
