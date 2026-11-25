(() => {
  const banner = document.querySelector("#connection-banner");
  const heading = document.querySelector("#connection-heading");
  const detail = document.querySelector("#connection-detail");
  const link = document.querySelector("#connection-action");
  const states = {
    connected: ["WhatsApp connected", "The bot is connected and can receive messages and send replies and handoffs.", "View connection"],
    disconnected: ["WhatsApp disconnected — bot offline", "The bot cannot receive messages, send replies, or send team handoffs. Connect WhatsApp to resume.", "Connect WhatsApp"],
    connecting: ["WhatsApp not connected — connecting…", "Replies and team handoffs are paused while the bot connects to WhatsApp.", "View connection"],
    disconnecting: ["WhatsApp disconnecting — bot offline", "The bot is removing its WhatsApp session. Replies and team handoffs are paused.", "View connection"],
    pairing: ["WhatsApp not connected — scan required", "Scan the QR code with your phone to enable replies and team handoffs.", "Scan QR code"],
    error: ["WhatsApp disconnected — connection failed", "The bot cannot receive messages, send replies, or send team handoffs. Open WhatsApp setup to reconnect.", "Reconnect WhatsApp"],
    unknown: ["WhatsApp connection unknown", "Could not check the connection. Bot availability is unconfirmed; retrying automatically.", "Check connection"]
  };
  window.showWhatsAppConnection = status => {
    const state = Object.hasOwn(states, status.state) ? status.state : "unknown";
    const [title, description, action] = states[state];
    banner.dataset.state = state;
    if (heading.textContent !== title) heading.textContent = title;
    if (detail.textContent !== description) detail.textContent = description;
    link.textContent = action;
  };

  // The setup page already polls and drives this same banner, including actions.
  // Keep the status visible and fresh on the Chats page as well.
  if (!document.querySelector("#connect-whatsapp")) {
    async function refresh() {
      try {
        const response = await fetch("/api/whatsapp", { signal: AbortSignal.timeout(10000), cache: "no-store" });
        if (!response.ok) throw new Error("Status unavailable");
        window.showWhatsAppConnection(await response.json());
      } catch {
        window.showWhatsAppConnection({ state: "unknown" });
      } finally {
        setTimeout(refresh, 2000);
      }
    }
    void refresh();
  }
})();
