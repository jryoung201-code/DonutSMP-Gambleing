package com.donutsmp.gamehub.net;

import com.donutsmp.gamehub.config.HubConfig;
import com.google.gson.*;
import java.net.URI;
import java.net.http.*;
import java.time.Duration;
import java.util.*;
import java.util.concurrent.CompletableFuture;

public final class BackendClient {
 private static final Gson GSON=new Gson(); private final HttpClient http=HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build(); private final URI base; private volatile String token;
 private BackendClient(URI base){this.base=base;}
 public static BackendClient create(String url){if(url==null||url.isBlank())return null;try{URI u=URI.create(url.trim().replaceAll("/+$",""));String h=u.getHost();boolean local="localhost".equals(h)||"127.0.0.1".equals(h);if(h!=null&&("https".equals(u.getScheme())||("http".equals(u.getScheme())&&local)))return new BackendClient(u);}catch(IllegalArgumentException ignored){}return null;}
 public CompletableFuture<HubConfig> fetchConfig(){return send("/api/config","GET",null).thenApply(r->{if(r.statusCode()!=200)throw new IllegalStateException("Config request failed (HTTP "+r.statusCode()+")");return parseConfig(GSON.fromJson(r.body(),JsonObject.class));});}
 public CompletableFuture<BetResponse> postBet(BetRequest body){return ensureAuthenticated().thenCompose(v->send("/api/bet","POST",GSON.toJson(body))).thenApply(r->{BetResponse x=GSON.fromJson(r.body(),BetResponse.class);if(x==null)throw new IllegalStateException("Empty response (HTTP "+r.statusCode()+")");return x;});}
 private CompletableFuture<HttpResponse<String>> send(String path,String method,String body){HttpRequest.Builder b=HttpRequest.newBuilder(URI.create(base+path)).timeout(Duration.ofSeconds(15));if(token!=null)b.header("Authorization","Bearer "+token);if("POST".equals(method)){b.header("Content-Type","application/json");b.POST(HttpRequest.BodyPublishers.ofString(body==null?"":body));}else b.GET();return http.sendAsync(b.build(),HttpResponse.BodyHandlers.ofString());}
 private CompletableFuture<Void> ensureAuthenticated(){if(token!=null)return CompletableFuture.completedFuture(null);return CompletableFuture.failedFuture(new IllegalStateException("Backend authentication is required before betting"));}
 static HubConfig parseConfig(JsonObject o){Set<String> enabled=new HashSet<>();if(o.has("enabledGames")&&o.get("enabledGames").isJsonArray())for(JsonElement e:o.getAsJsonArray("enabledGames"))enabled.add(e.getAsString());Map<String,Long> crates=new HashMap<>();if(o.has("cratePrices")&&o.get("cratePrices").isJsonObject())for(var e:o.getAsJsonObject("cratePrices").entrySet())crates.put(e.getKey(),e.getValue().getAsLong());return HubConfig.validated(o.get("minimumBet").getAsLong(),o.get("maximumBet").getAsLong(),o.get("paymentTarget").getAsString(),enabled,o.has("showOdds")&&o.get("showOdds").getAsBoolean(),crates);}
}
