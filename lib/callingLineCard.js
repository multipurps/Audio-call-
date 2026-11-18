// The "Calling lines" row on Connected accounts. A verified (or rented) number is shown right there,
// the same way Telegram and WhatsApp show "Connected as ...": the number, and a button to remove it.
// Opening the full "Set Up Calling" page just to see that it is connected is never needed.

export const lineIsUsable = (line) => Boolean(line && ['verified', 'rented'].includes(line.status));

// -> { connected, title, sub, action }   action: 'Remove' | 'Release' | null (button text)
export function callingLineCardView({ line = null, channels = {} } = {}) {
  if (lineIsUsable(line) && line.phoneNumber) {
    const rented = line.mode === 'rent';
    return {
      connected: true,
      title: `Connected as ${line.phoneNumber}`,
      sub: rented ? 'Rented number' : 'Your calling number',
      action: rented ? 'Release' : 'Remove',
    };
  }
  return {
    connected: false,
    title: 'Calling lines',
    sub: channels.whatsapp ? 'WhatsApp' : 'Not set up yet',
    action: null,
  };
}

// What the confirmation asks before the number is removed or released.
export function removeLineConfirm(line) {
  const rented = line?.mode === 'rent';
  return {
    title: rented ? 'Release your rented number?' : 'Remove your verified number?',
    message: rented ? 'You will lose it.' : '',
    confirmLabel: rented ? 'Release' : 'Remove',
    destructive: true,
  };
}
