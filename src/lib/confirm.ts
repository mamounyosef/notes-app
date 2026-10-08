/**
 * Yes or no question. The desktop app asks through a native dialog in the main
 * process, because window.confirm() there leaves text fields unable to take
 * typing on Windows. The browser version falls back to window.confirm().
 */
export async function askConfirm(message: string, okLabel = 'OK'): Promise<boolean> {
  const desktop = (window as any).notes
  if (desktop?.confirm) return desktop.confirm(message, okLabel)
  return window.confirm(message)
}
