package com.donutsmp.gamehub;

import com.donutsmp.gamehub.config.ClientSettings;
import com.donutsmp.gamehub.net.BackendClient;
import com.donutsmp.gamehub.screen.GameScreen;
import com.donutsmp.gamehub.screen.HubScreen;
import net.fabricmc.api.ClientModInitializer;
import net.fabricmc.fabric.api.client.command.v2.ClientCommandManager;
import net.fabricmc.fabric.api.client.command.v2.ClientCommandRegistrationCallback;
import net.fabricmc.fabric.api.client.message.v1.ClientReceiveMessageEvents;
import net.minecraft.client.MinecraftClient;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

public final class GameHubClient implements ClientModInitializer {
    public static final String MOD_ID = "donutsmp_gamehub";
    public static final Logger LOGGER = LoggerFactory.getLogger("DonutSMP Game Hub");
    private static HubSession session;

    public static HubSession session() {
        return session;
    }

    @Override
    public void onInitializeClient() {
        ClientSettings settings = ClientSettings.load();
        session = new HubSession(BackendClient.create(settings.backendUrl()));

        ClientReceiveMessageEvents.GAME.register((message, overlay) ->
            MinecraftClient.getInstance().execute(() -> GameScreen.receiveServerMessage(message)));

        ClientCommandRegistrationCallback.EVENT.register((dispatcher, registryAccess) ->
            dispatcher.register(ClientCommandManager.literal("gamehub").executes(ctx -> {
                MinecraftClient mc = MinecraftClient.getInstance();
                mc.execute(() -> {
                    session.refresh();
                    mc.setScreen(new HubScreen(null, session));
                });
                return 1;
            }))
        );
    }
}
