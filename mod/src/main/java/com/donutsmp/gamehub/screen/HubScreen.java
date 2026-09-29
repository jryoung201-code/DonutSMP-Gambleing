package com.donutsmp.gamehub.screen;

import com.donutsmp.gamehub.HubSession;
import com.donutsmp.gamehub.config.HubConfig;
import com.donutsmp.gamehub.game.Game;
import com.donutsmp.gamehub.money.MoneyFormat;
import net.minecraft.client.gui.DrawContext;
import net.minecraft.client.gui.screen.Screen;
import net.minecraft.client.gui.widget.ButtonWidget;
import net.minecraft.item.Item;
import net.minecraft.item.ItemStack;
import net.minecraft.item.Items;
import net.minecraft.text.Text;

import java.util.EnumMap;
import java.util.Map;

public final class HubScreen extends Screen {
    private static final int COLUMNS = 3;
    private static final int GAP = 8;
    private final Screen parent;
    private final HubSession session;
    private final Map<Game, ButtonWidget> gameButtons = new EnumMap<>(Game.class);
    private ButtonWidget copyButton;
    private ButtonWidget refreshButton;
    private int px, py, pw, ph, cardWidth, cardHeight;

    public HubScreen(Screen parent, HubSession session) {
        super(Text.literal("DonutSMP Game Hub"));
        this.parent = parent;
        this.session = session;
    }

    @Override
    protected void init() {
        gameButtons.clear();
        pw = Math.max(300, Math.min(width - 20, 760));
        ph = Math.max(280, Math.min(height - 20, 430));
        px = (width - pw) / 2;
        py = (height - ph) / 2;
        cardWidth = (pw - 28 - GAP * (COLUMNS - 1)) / COLUMNS;
        cardHeight = (ph - 142 - GAP) / 2;

        Game[] games = Game.values();
        for (int i = 0; i < games.length; i++) {
            Game game = games[i];
            int col = i % COLUMNS;
            int row = i / COLUMNS;
            int x = px + 14 + col * (cardWidth + GAP);
            int y = py + 100 + row * (cardHeight + GAP);
            int buttonY = y + cardHeight - 31;
            ButtonWidget button = ButtonWidget.builder(Text.literal("PLAY"),
                    btn -> client.setScreen(new GameScreen(this, session, game)))
                .dimensions(x + 8, buttonY, cardWidth - 16, 23)
                .build();
            gameButtons.put(game, addDrawableChild(button));
        }

        copyButton = addDrawableChild(ButtonWidget.builder(Text.literal("Copy"),
                btn -> {
                    HubConfig config = session.config();
                    if (config != null) client.keyboard.setClipboard(config.payCommand());
                })
            .dimensions(px + pw - 59, py + 53, 48, 18)
            .build());
        refreshButton = addDrawableChild(ButtonWidget.builder(Text.literal("Refresh"),
                btn -> session.refresh())
            .dimensions(px + 14, py + ph - 27, 58, 18)
            .build());
        addDrawableChild(ButtonWidget.builder(Text.literal("Close"), btn -> close())
            .dimensions(px + pw - 72, py + ph - 27, 58, 18)
            .build());
    }

    @Override
    public void tick() {
        HubConfig config = session.config();
        for (var entry : gameButtons.entrySet()) {
            entry.getValue().active = config != null && config.isEnabled(entry.getKey());
        }
        copyButton.active = config != null;
        refreshButton.active = !session.loading() && session.backend() != null;
    }

    @Override
    public void renderBackground(DrawContext ctx, int mouseX, int mouseY, float delta) {
        super.renderBackground(ctx, mouseX, mouseY, delta);
        Theme.panel(ctx, px, py, pw, ph);
        ctx.drawCenteredTextWithShadow(textRenderer, Text.literal("DonutSMP Game Hub"),
            width / 2, py + 12, Theme.TEXT);
        ctx.drawCenteredTextWithShadow(textRenderer, Text.literal("Choose a game and play"),
            width / 2, py + 28, Theme.MUTED);

        HubConfig config = session.config();
        String command = config == null ? "/pay VoduDoll_YT <amount>" : config.payCommand() + " <amount>";
        ctx.drawTextWithShadow(textRenderer, Text.literal("PAY COMMAND"), px + 14, py + 53, Theme.MUTED);
        ctx.drawTextWithShadow(textRenderer, Text.literal(command), px + 92, py + 53, Theme.TEXT);

        Game[] games = Game.values();
        for (int i = 0; i < games.length; i++) {
            Game game = games[i];
            int col = i % COLUMNS;
            int row = i / COLUMNS;
            int x = px + 14 + col * (cardWidth + GAP);
            int y = py + 100 + row * (cardHeight + GAP);
            drawCard(ctx, game, config, x, y);
        }

        int statusColor = config == null ? Theme.BAD : Theme.GOOD;
        ctx.drawCenteredTextWithShadow(textRenderer, Text.literal(session.status()),
            width / 2, py + ph - 42, statusColor);
    }

    private void drawCard(DrawContext ctx, Game game, HubConfig config, int x, int y) {
        ctx.fill(x, y, x + cardWidth, y + cardHeight, 0xFF20202A);
        ctx.fill(x, y, x + cardWidth, y + 1, 0xFF363644);
        ctx.fill(x, y + cardHeight - 1, x + cardWidth, y + cardHeight, 0xFF363644);
        ctx.fill(x, y, x + 1, y + cardHeight, 0xFF363644);
        ctx.fill(x + cardWidth - 1, y, x + cardWidth, y + cardHeight, 0xFF363644);

        Item icon = iconFor(game);
        ctx.drawItem(new ItemStack(icon), x + (cardWidth - 16) / 2, y + 14);
        ctx.drawCenteredTextWithShadow(textRenderer, Text.literal(game.title()),
            x + cardWidth / 2, y + 38, Theme.TEXT);

        if (config == null) {
            ctx.drawCenteredTextWithShadow(textRenderer, Text.literal("Limits unavailable"),
                x + cardWidth / 2, y + 57, Theme.MUTED);
        } else if (game.usesBet()) {
            ctx.drawCenteredTextWithShadow(textRenderer,
                Text.literal("Min " + MoneyFormat.compact(config.minimumBet())
                    + "  |  Max " + MoneyFormat.compact(config.maximumBet())),
                x + cardWidth / 2, y + 57, Theme.MUTED);
        } else {
            ctx.drawCenteredTextWithShadow(textRenderer, Text.literal("Choose a crate"),
                x + cardWidth / 2, y + 57, Theme.MUTED);
        }

        if (config != null && !config.isEnabled(game)) {
            ctx.drawCenteredTextWithShadow(textRenderer, Text.literal("Disabled by server"),
                x + cardWidth / 2, y + 73, Theme.BAD);
        }
    }

    private Item iconFor(Game game) {
        return switch (game) {
            case FIFTY_FIFTY -> Items.EMERALD;
            case WHEEL -> Items.COMPASS;
            case CRATES -> Items.CHEST;
            case HORSE_RACING -> Items.SADDLE;
            case FORTY_FIVE -> Items.DIAMOND;
            case ODD_EVEN -> Items.SUNFLOWER;
        };
    }

    @Override
    public void close() {
        client.setScreen(parent);
    }
}
