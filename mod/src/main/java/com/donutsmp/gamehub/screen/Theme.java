package com.donutsmp.gamehub.screen;
import net.minecraft.client.gui.DrawContext;
final class Theme {private Theme(){}static final int PANEL=0xF0181820,BORDER=0xFF3A3A4A,ACCENT=0xFF5865F2,TEXT=0xFFFFFFFF,MUTED=0xFFAAAAB8,GOOD=0xFF4ADE80,BAD=0xFFF87171;static void panel(DrawContext ctx,int x,int y,int w,int h){ctx.fill(x-1,y-1,x+w+1,y+h+1,BORDER);ctx.fill(x,y,x+w,y+h,PANEL);}}
