package com.donutsmp.gamehub.screen;

import com.donutsmp.gamehub.GameHubClient;
import com.donutsmp.gamehub.HubSession;
import com.donutsmp.gamehub.config.HubConfig;
import com.donutsmp.gamehub.game.Game;
import com.donutsmp.gamehub.money.AmountParser;
import com.donutsmp.gamehub.money.MoneyFormat;
import com.donutsmp.gamehub.net.BetRequest;
import com.donutsmp.gamehub.net.BetResponse;
import com.donutsmp.gamehub.net.PaymentTransactionResponse;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.gui.DrawContext;
import net.minecraft.client.gui.screen.Screen;
import net.minecraft.client.gui.widget.ButtonWidget;
import net.minecraft.client.gui.widget.TextFieldWidget;
import net.minecraft.text.Text;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.UUID;

public final class GameScreen extends Screen {
    private final Screen parent;
    private final HubSession session;
    private final Game game;
    private TextFieldWidget betField;
    private final List<ButtonWidget> playButtons = new ArrayList<>();
    private int px, py, pw, ph;
    private boolean busy;
    private boolean awaitingPaymentReply;
    private int replyTicks;
    private String expectedTarget;
    private String chosenSelection;
    private String paymentTransactionId;
    private String profileUuid;
    private long chosenAmount;
    private String message = "";
    private int messageColor = Theme.MUTED;

    public GameScreen(Screen parent, HubSession session, Game game) {
        super(Text.literal(game.title()));
        this.parent = parent;
        this.session = session;
        this.game = game;
    }

    @Override
    protected void init() {
        playButtons.clear();
        pw = Math.max(240, Math.min(width - 24, 400));
        ph = 164 + (game.usesBet() ? 0 : -36) + 28;
        px = (width - pw) / 2;
        py = Math.max(6, (height - ph) / 2);
        int y = py + 100 + (game.usesBet() ? 0 : -36);
        if (game.usesBet()) {
            betField = new TextFieldWidget(textRenderer, px + 10, py + 64, pw - 20, 18, Text.literal("Amount"));
            betField.setMaxLength(24);
            betField.setPlaceholder(Text.literal("Payment amount (e.g. 500k, 1.5m, 2000000)"));
            addDrawableChild(betField);
        }
        int n = game.selections().isEmpty() ? 1 : game.selections().size();
        int gap = 6;
        int bw = (pw - 20 - gap * (n - 1)) / n;
        for (int i = 0; i < n; i++) {
            String id = game.selections().isEmpty() ? null : game.selections().get(i).id();
            String label = game.usesBet() ? "PLAY" : (game.selections().isEmpty() ? "PLAY" : game.selections().get(i).label());
            ButtonWidget button = ButtonWidget.builder(Text.literal(label), btn -> submit(id))
                .dimensions(px + 10 + i * (bw + gap), y, bw, 24).build();
            playButtons.add(addDrawableChild(button));
        }
        addDrawableChild(ButtonWidget.builder(Text.literal("Back"), btn -> close())
            .dimensions(px + 10, py + ph - 26, 60, 18).build());
    }

    @Override
    public void tick() {
        HubConfig config = session.config();
        boolean ok = config != null && config.isEnabled(game) && !busy;
        for (ButtonWidget button : playButtons) button.active = ok;
        if (awaitingPaymentReply && ++replyTicks > 100) {
            awaitingPaymentReply = false;
            busy = false;
            show("No payment confirmation received; check server chat.", Theme.MUTED);
        }
    }

    public static void receiveServerMessage(Text text) {
        MinecraftClient client = MinecraftClient.getInstance();
        if (client.currentScreen instanceof GameScreen screen) screen.onServerPaymentMessage(text.getString());
    }

    private void onServerPaymentMessage(String raw) {
        if (!awaitingPaymentReply) return;
        String line = raw.toLowerCase(Locale.ROOT);
        if (line.contains("don''t have enough funds") || line.contains("do not have enough funds") ||
            line.contains("not have enough funds") || line.contains("insufficient funds")) {
            awaitingPaymentReply = false;
            busy = false;
            show("Payment rejected: not enough funds.", Theme.BAD);
            return;
        }
        if (expectedTarget != null && line.contains("you paid " + expectedTarget.toLowerCase(Locale.ROOT))) {
            awaitingPaymentReply = false;
            show("Payment confirmed. Getting the result from the backend…", Theme.MUTED);
            resolveRound();
        }
    }

    private void resolveRound() {
        if (session.backend() == null) {
            busy = false;
            show("Payment went through, but the backend is unavailable. Contact admin with transaction " + paymentTransactionId, Theme.BAD);
            return;
        }
        var auth = client.getSession();
        session.backend().confirmPaymentTransaction(paymentTransactionId)
            .thenCompose(ignored -> session.backend().postBet(
                new BetRequest(paymentTransactionId, profileUuid, game.id(), chosenAmount, chosenSelection)))
            .whenComplete((result, error) -> client.execute(() -> {
                if (error != null) {
                    busy = false;
                    GameHubClient.LOGGER.warn("Game result request failed after payment", error);
                    show("Payment sent; result failed. Contact admin with transaction " + paymentTransactionId, Theme.BAD);
                    return;
                }
                if (result == null || !result.accepted) {
                    busy = false;
                    show(result == null ? "Backend returned no game result." : result.reason, Theme.BAD);
                    return;
                }
                busy = false;
                if ("JACKPOT".equals(result.result)) {
                    show("JACKPOT! Payout: " + MoneyFormat.grouped(result.payout) + " — bot payment queued.", 0xFFFFD54F);
                } else if ("WIN".equals(result.result)) {
                    show("WIN! Payout: " + MoneyFormat.grouped(result.payout) + " — bot payment queued.", Theme.GOOD);
                } else {
                    show("LOSE. Payout: 0.", Theme.BAD);
                }
            }));
    }

    private void submit(String selection) {
        HubConfig config = session.config();
        if (busy || config == null || !game.usesBet()) return;
        AmountParser.ParseResult parsed = AmountParser.parse(betField == null ? "" : betField.getText());
        if (!parsed.ok()) { show(parsed.error(), Theme.BAD); return; }
        long amount = parsed.value();
        if (amount < config.minimumBet()) { show("Minimum amount is " + MoneyFormat.compact(config.minimumBet()) + ".", Theme.BAD); return; }
        if (amount > config.maximumBet()) { show("Maximum amount is " + MoneyFormat.compact(config.maximumBet()) + ".", Theme.BAD); return; }
        if (client.player == null) return;
        if (session.backend() == null) { show("Backend is unavailable; payment was not sent.", Theme.BAD); return; }
        var minecraftSession = client.getSession();
        UUID uuid = minecraftSession.getUuidOrNull();
        if (uuid == null) { show("Minecraft profile is unavailable; payment was not sent.", Theme.BAD); return; }

        busy = true;
        chosenAmount = amount;
        chosenSelection = selection;
        profileUuid = uuid.toString();
        show("Recording payment transaction…", Theme.MUTED);
        session.backend().createPaymentTransaction(minecraftSession.getUsername(), minecraftSession.getAccessToken(), uuid, amount)
            .whenComplete((transaction, error) -> client.execute(() -> {
                if (error != null) {
                    busy = false;
                    GameHubClient.LOGGER.warn("Payment transaction could not be recorded", error);
                    show("Payment was not sent: backend transaction failed.", Theme.BAD);
                    return;
                }
                if (client.player == null) {
                    busy = false;
                    show("Transaction " + transaction.transactionId + " recorded; payment command not sent.", Theme.BAD);
                    return;
                }
                try {
                    expectedTarget = transaction.target;
                    paymentTransactionId = transaction.transactionId;
                    awaitingPaymentReply = true;
                    replyTicks = 0;
                    client.player.networkHandler.sendChatCommand("pay " + transaction.target + " " + transaction.amount);
                    show("Transaction " + transaction.transactionId + " recorded; waiting for server.", Theme.MUTED);
                } catch (RuntimeException e) {
                    awaitingPaymentReply = false;
                    busy = false;
                    GameHubClient.LOGGER.warn("Payment command failed after transaction was recorded", e);
                    show("Transaction " + transaction.transactionId + " recorded, but /pay could not be sent.", Theme.BAD);
                }
            }));
    }

    private void show(String text, int color) { message = text; messageColor = color; }

    @Override
    public void renderBackground(DrawContext ctx, int mouseX, int mouseY, float delta) {
        super.renderBackground(ctx, mouseX, mouseY, delta);
        Theme.panel(ctx, px, py, pw, ph);
        ctx.drawCenteredTextWithShadow(textRenderer, Text.literal(game.title()), width / 2, py + 10, Theme.TEXT);
        HubConfig config = session.config();
        if (config == null) ctx.drawCenteredTextWithShadow(textRenderer, Text.literal(session.status()), width / 2, py + 26, Theme.BAD);
        else if (!config.isEnabled(game)) ctx.drawCenteredTextWithShadow(textRenderer, Text.literal("This game is disabled by the server"), width / 2, py + 26, Theme.BAD);
        else if (game.usesBet()) {
            ctx.drawTextWithShadow(textRenderer, Text.literal("Min Amount " + MoneyFormat.compact(config.minimumBet()) + "   Max Amount " + MoneyFormat.compact(config.maximumBet())), px + 10, py + 26, Theme.MUTED);
            ctx.drawTextWithShadow(textRenderer, Text.literal("Payment: " + config.payCommand()), px + 10, py + 40, Theme.TEXT);
            AmountParser.ParseResult parsed = AmountParser.parse(betField == null ? "" : betField.getText());
            String hint = betField != null && betField.getText().isBlank() ? "" : parsed.ok() ? "= " + MoneyFormat.grouped(parsed.value()) : parsed.error();
            int color = parsed.ok() ? Theme.MUTED : Theme.BAD;
            ctx.drawTextWithShadow(textRenderer, Text.literal(hint), px + 10, py + 84, color);
        } else {
            ctx.drawTextWithShadow(textRenderer, Text.literal("No bet needed. Pick a crate."), px + 10, py + 26, Theme.MUTED);
            StringBuilder prices = new StringBuilder();
            for (Game.Selection item : game.selections()) {
                Long price = config.cratePrices().get(item.id());
                if (price != null) prices.append(item.label()).append('' '').append(MoneyFormat.compact(price)).append("   ");
            }
            ctx.drawTextWithShadow(textRenderer, Text.literal(prices.toString().trim()), px + 10, py + 40, Theme.MUTED);
        }
        ctx.drawCenteredTextWithShadow(textRenderer, Text.literal(message), width / 2, py + ph - 48, messageColor);
    }

    @Override
    public void close() { client.setScreen(parent); }
}
