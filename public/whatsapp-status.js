(() => {
  const banner = document.querySelector("#connection-banner");
  const heading = document.querySelector("#connection-heading");
  const detail = document.querySelector("#connection-detail");
  const link = document.querySelector("#connection-action");
  const states = {
    connected: ["WhatsApp connected — replies unverified", "Send a test message from another WhatsApp account to verify automatic replies.", "View connection"],
    disconnected: ["WhatsApp disconnected — bot offline", "The bot cannot receive messages, send replies, or send team handoffs. Connect WhatsApp to resume.", "Connect WhatsApp"],
    connecting: ["WhatsApp not connected — connecting…", "Replies and team handoffs are paused while the bot connects to WhatsApp.", "View connection"],
    disconnecting: ["WhatsApp disconnecting — bot offline", "The bot is removing its WhatsApp session. Replies and team handoffs are paused.", "View connection"],
    pairing: ["WhatsApp not connected — scan required", "Scan the QR code with your phone to enable replies and team handoffs.", "Scan QR code"],
    error: ["WhatsApp disconnected — connection failed", "The bot cannot receive messages, send replies, or send team handoffs. Open WhatsApp setup to reconnect.", "Reconnect WhatsApp"],
    unknown: ["WhatsApp connection unknown", "Could not check the connection. Bot availability is unconfirmed; retrying automatically.", "Check connection"]
  };
  window.showWhatsAppConnection = status => {
    const state = Object.hasOwn(states, status.state) ? status.state : "unknown";
    let [title, description, action] = states[state];
    let appearance = state;
    link.href = "/#whatsapp";
    if (state === "connected") {
      const activity = status.activity || { state: "unverified" };
      if (activity.state === "error") {
        title = "WhatsApp connected — replies failing";
        description = activity.message || "A message could not be processed. Check the AI provider and service logs.";
        action = "Check AI provider";
        link.href = "/#provider";
        appearance = "reply-error";
      } else if (activity.state === "ignored") {
        title = "WhatsApp connected — message ignored";
        description = activity.message || "The last message was excluded from automatic replies.";
        appearance = "unverified";
      } else if (activity.state === "received" || activity.state === "processing") {
        title = "WhatsApp connected — preparing reply";
        description = "An incoming message was received. Waiting for the bot to complete its reply.";
        appearance = "unverified";
      } else if (activity.state === "replied") {
        title = "WhatsApp connected — reply sent";
        description = "The latest automatic reply was submitted to WhatsApp. Delivery and reading are not confirmed.";
      } else {
        appearance = "unverified";
      }
      if (status.linkedPhone) description = "Linked number: " + status.linkedPhone + ". " + description;
      if (activity.lastReceivedAt) description += " Last message received: " + new Date(activity.lastReceivedAt).toLocaleString() + ".";
      if (activity.lastReplyAt) description += " Last successful reply: " + new Date(activity.lastReplyAt).toLocaleString() + ".";
      if (activity.lastEventAt && !activity.lastReceivedAt) description += " Last WhatsApp message event: " + new Date(activity.lastEventAt).toLocaleString() + " (" + activity.lastEventType + ").";
    }
    banner.dataset.state = appearance;
    if (heading.textContent !== title) heading.textContent = title;
    if (detail.textContent !== description) detail.textContent = description;
    link.textContent = action;
    return { title, description };
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
