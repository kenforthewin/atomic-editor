// React 18's `act` helper emits a console warning unless this flag
// is set to indicate we're in a test environment where scheduled
// effects should be flushed synchronously.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
