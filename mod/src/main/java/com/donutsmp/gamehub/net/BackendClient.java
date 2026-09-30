package com.donutsmp.gamehub.net;

import com.donutsmp.gamehub.config.HubConfig;
import com.google.gson.*;
import java.net.URI;
import java.net.http.*;
import java.time.Duration;
import java.util.*;
import java.util.concurrent.CompletableFuture;
import java.util.UUID;

public final class BackendClient {
 private static final Gson GSON=new Gson(); private final HttpClient http=HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build(); private final URI base; private volatile String token; private volatile long tokenExpiresAt;
 private BackendClient(URI base){this.base=base;}
 public static BackendClient create(String url){if(url==null||url.isBlank())return null;try{URI u=URI.create(url.trim().replaceAll("/+$",""));String h=u.getHost();boolean local="localhost".equals(h)||"127.0.0.1".equals(h);if(h!=null&&("https".equals(u.getScheme())||("http".equals(u.getScheme())&&local)))return new BackendClient(u);}catch(IllegalArgumentException ignored){}return null;}
 public CompletableFuture<HubConfig> fetchConfig(){return send("/api/config","GET",null).thenApply(r->{if(r.statusCode()!=200)throw new IllegalStateException("Config request failed (HTTP "+r.statusCode()+")");return parseConfig(GSON.fromJson(r.body(),JsonObject.class));});}
 public CompletableFuture<PaymentTransactionResponse> createPaymentTransaction(String username,String accessToken,UUID profileUuid,long amount){
  return ensureAuthenticated(username,accessToken,profileUuid)
   .thenCompose(v->send("/api/payment-transactions","POST",GSON.toJson(Map.of("amount",amount))))
   .thenApply(r->{PaymentTransactionResponse x=GSON.fromJson(r.body(),PaymentTransactionResponse.class);if(x==null)throw new IllegalStateException("Empty payment transaction response (HTTP "+r.statusCode()+")");if(r.statusCode()!=201||!x.accepted)throw new IllegalStateException(x.reason==null?"Payment transaction failed (HTTP "+r.statusCode()+")":x.reason);return x;});
 }
 public CompletableFuture<Void> confirmPaymentTransaction(String transactionId){
  return ensureAuthenticated().thenCompose(v->send("/api/payment-transactions/"+transactionId+"/confirm","POST","{}"))
   .thenApply(r->{JsonObject x=GSON.fromJson(r.body(),JsonObject.class);if(r.statusCode()!=200||x==null||!x.has("accepted")||!x.get("accepted").getAsBoolean())throw new IllegalStateException(x!=null&&x.has("reason")?x.get("reason").getAsString():"Payment confirmation failed (HTTP "+r.statusCode()+")");return null;});
 }
 private CompletableFuture<Void> ensureAuthenticated(String username,String accessToken,UUID profileUuid){
  if(token!=null&&System.currentTimeMillis()<tokenExpiresAt-30000)return CompletableFuture.completedFuture(null);
  if(username==null||accessToken==null||profileUuid==null)return CompletableFuture.failedFuture(new IllegalStateException("Minecraft session is unavailable"));
  return send("/api/auth/challenge","POST","{}").thenCompose(challengeResponse->{
   if(challengeResponse.statusCode()!=200)return CompletableFuture.failedFuture(new IllegalStateException("Authentication challenge failed (HTTP "+challengeResponse.statusCode()+")"));
   JsonObject challenge=GSON.fromJson(challengeResponse.body(),JsonObject.class);
   String serverId=challenge.get("serverId").getAsString();
   JsonObject joinBody=new JsonObject();joinBody.addProperty("accessToken",accessToken);joinBody.addProperty("selectedProfile",profileUuid.toString().replace("-",""));joinBody.addProperty("serverId",serverId);
   HttpRequest joinRequest=HttpRequest.newBuilder(URI.create("https://sessionserver.mojang.com/session/minecraft/join")).timeout(Duration.ofSeconds(15)).header("Content-Type","application/json").POST(HttpRequest.BodyPublishers.ofString(GSON.toJson(joinBody))).build();
   return http.sendAsync(joinRequest,HttpResponse.BodyHandlers.ofString()).thenCompose(joinResponse->{
    if(joinResponse.statusCode()<200||joinResponse.statusCode()>=300)return CompletableFuture.failedFuture(new IllegalStateException("Mojang session verification failed (HTTP "+joinResponse.statusCode()+")"));
    JsonObject loginBody=new JsonObject();loginBody.addProperty("username",username);loginBody.addProperty("serverId",serverId);
    return send("/api/auth/login","POST",GSON.toJson(loginBody)).thenAccept(loginResponse->{
     if(loginResponse.statusCode()!=200)throw new IllegalStateException("Backend login failed (HTTP "+loginResponse.statusCode()+")");
     JsonObject login=GSON.fromJson(loginResponse.body(),JsonObject.class);token=login.get("token").getAsString();tokenExpiresAt=System.currentTimeMillis()+login.get("expiresInSeconds").getAsLong()*1000L;
    });
   });
  });
 }
 public CompletableFuture<BetResponse> postBet(BetRequest body){return ensureAuthenticated().thenCompose(v->send("/api/bet","POST",GSON.toJson(body))).thenApply(r->{BetResponse x=GSON.fromJson(r.body(),BetResponse.class);if(x==null)throw new IllegalStateException("Empty response (HTTP "+r.statusCode()+")");return x;});}
 private CompletableFuture<HttpResponse<String>> send(String path,String method,String body){HttpRequest.Builder b=HttpRequest.newBuilder(URI.create(base+path)).timeout(Duration.ofSeconds(15));if(token!=null)b.header("Authorization","Bearer "+token);if("POST".equals(method)){b.header("Content-Type","application/json");b.POST(HttpRequest.BodyPublishers.ofString(body==null?"":body));}else b.GET();return http.sendAsync(b.build(),HttpResponse.BodyHandlers.ofString());}
 private CompletableFuture<Void> ensureAuthenticated(){if(token!=null)return CompletableFuture.completedFuture(null);return CompletableFuture.failedFuture(new IllegalStateException("Backend authentication is required before betting"));}
 static HubConfig parseConfig(JsonObject o){Set<String> enabled=new HashSet<>();if(o.has("enabledGames")&&o.get("enabledGames").isJsonArray())for(JsonElement e:o.getAsJsonArray("enabledGames"))enabled.add(e.getAsString());Map<String,Long> crates=new HashMap<>();if(o.has("cratePrices")&&o.get("cratePrices").isJsonObject())for(var e:o.getAsJsonObject("cratePrices").entrySet())crates.put(e.getKey(),e.getValue().getAsLong());return HubConfig.validated(o.get("minimumBet").getAsLong(),o.get("maximumBet").getAsLong(),o.get("paymentTarget").getAsString(),enabled,o.has("showOdds")&&o.get("showOdds").getAsBoolean(),o.has("playerPayEnabled")&&o.get("playerPayEnabled").getAsBoolean(),crates);}
}
