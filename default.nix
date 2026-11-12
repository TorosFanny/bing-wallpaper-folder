{ lib, stdenv, glib }:

stdenv.mkDerivation {
  pname = "gnome-shell-extension-bing-wallpaper-folder";
  version = "4";

  # 源码随 flake 一起分发，无需 fetch；src 即本目录，走默认解包
  src = ./.;
  dontConfigure = true;
  dontBuild = true;

  nativeBuildInputs = [ glib ];

  installPhase = ''
    runHook preInstall
    extDir="$out/share/gnome-shell/extensions/bing-wallpaper-folder@torosfanny.github.io"
    mkdir -p "$extDir"
    cp extension.js bing.js library.js prefs.js stylesheet.css metadata.json "$extDir/"
    mkdir -p "$extDir/schemas"
    cp schemas/*.xml "$extDir/schemas/"
    glib-compile-schemas "$extDir/schemas"
    runHook postInstall
  '';

  meta = with lib; {
    description = "Bing daily wallpaper extension driven by the wallpaper folder (folder is the source of truth)";
    platforms = platforms.linux;
  };
}
