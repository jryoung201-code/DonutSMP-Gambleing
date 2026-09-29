package com.donutsmp.gamehub.game;
import java.util.List;import java.util.Optional;
public enum Game {
 FIFTY_FIFTY("50_50","50/50",true,List.of()),WHEEL("wheel","Wheel",true,List.of()),CRATES("crates","Crates",false,List.of(new Selection("basic","Basic Crate"),new Selection("rare","Rare Crate"),new Selection("legendary","Legendary Crate"))),HORSE_RACING("horseRacing","Horse Racing",true,List.of(new Selection("diamond","Diamond"),new Selection("iron","Iron"),new Selection("gold","Gold"))),FORTY_FIVE("45_45_10","45/45/10",true,List.of()),ODD_EVEN("oddEven","Odd or Even",true,List.of(new Selection("odd","ODD"),new Selection("even","EVEN")));
 public record Selection(String id,String label){} private final String id,title;private final boolean usesBet;private final List<Selection> selections;
 Game(String id,String title,boolean usesBet,List<Selection> selections){this.id=id;this.title=title;this.usesBet=usesBet;this.selections=selections;}public String id(){return id;}public String title(){return title;}public boolean usesBet(){return usesBet;}public List<Selection> selections(){return selections;}public static Optional<Game> byId(String id){for(Game g:values())if(g.id.equals(id))return Optional.of(g);return Optional.empty();}
}
