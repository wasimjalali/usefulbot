import { eveChannel } from "eve/channels/eve";
import { channelAuth } from "../lib/channel-auth.ts";

export default eveChannel({
  auth: [channelAuth()],
  turnPolicy: "queue",
});
