package com.donutsmp.gamehub.net;
import com.google.gson.JsonObject;import com.google.gson.annotations.SerializedName;
public final class BetResponse {public boolean accepted;public String transactionId;public String result;@SerializedName(value="bet",alternate={"amount"})public long bet;public long payout;public String multiplier;public long multiplierBasisPoints;public long balance;public boolean replayed;public String reason;public String code;public JsonObject detail;}
