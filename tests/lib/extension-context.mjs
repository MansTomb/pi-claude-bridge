export const withSessionContext = (handler) => (event, context = {}) => handler(event, {
  sessionManager: { getSessionId: () => "unit-session", getHeader: () => ({}) },
  ...context,
});
