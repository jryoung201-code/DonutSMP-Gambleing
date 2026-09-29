package com.donutsmp.gamehub;

import com.donutsmp.gamehub.config.HubConfig;
import com.donutsmp.gamehub.net.BackendClient;

/** Holds the latest server configuration and connection status; shared by all screens. */
public final class HubSession {
    private final BackendClient backend;
    private volatile HubConfig config;
    private volatile String status;
    private volatile boolean loading;
    public HubSession(BackendClient backend){this.backend=backend;this.status=backend==null?"Backend URL not set. Edit config/donutsmp-gamehub.json (https only).":"Not connected yet.";}
    public BackendClient backend(){return backend;} public HubConfig config(){return config;} public String status(){return status;} public boolean loading(){return loading;}
    public void refresh(){if(backend==null||loading)return;loading=true;status="Connecting to backend...";backend.fetchConfig().whenComplete((cfg,err)->{if(err==null){config=cfg;status="Connected";}else{config=null;Throwable c=err.getCause()!=null?err.getCause():err;GameHubClient.LOGGER.warn("Config fetch failed",c);status="Backend unavailable: "+shorten(c.getMessage());}loading=false;});}
    private static String shorten(String s){if(s==null)return"error";s=s.replace('\u00a7',' ');return s.length()>80?s.substring(0,80)+"...":s;}
}
