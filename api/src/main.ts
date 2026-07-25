import { bold, cyan } from "@std/fmt/colors";
import { app } from "./features/app/app.ts";
import { ConfigClient } from "./clients/config-client/configClient.ts";

if (import.meta.main) {
  Deno.serve(
    {
      port: ConfigClient.Server.port,
      onListen({ port, hostname }) {
        console.log(
          `Server started at ${cyan(bold(`http://${hostname}:${port}`))}`,
        );
      },
    },
    app.fetch,
  );
}
