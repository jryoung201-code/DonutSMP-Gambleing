package com.donutsmp.gamehub.net;
public final class BetRequest {public final String transactionId,playerUuid,game,selection;public final long bet;public BetRequest(String transactionId,String playerUuid,String game,long bet,String selection){this.transactionId=transactionId;this.playerUuid=playerUuid;this.game=game;this.bet=bet;this.selection=selection;}}
