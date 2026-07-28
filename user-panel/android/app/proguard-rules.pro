# Add project specific ProGuard rules here.
# You can control the set of applied configuration files using the
# proguardFiles setting in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# If your project uses WebView with JS, uncomment the following
# and specify the fully qualified class name to the JavaScript interface
# class:
#-keepclassmembers class fqcn.of.javascript.interface.for.webview {
#   public *;
#}

# Uncomment this to preserve the line number information for
# debugging stack traces.
#-keepattributes SourceFile,LineNumberTable

# If you keep the line number information, uncomment this to
# hide the original source file name.
#-renamesourcefileattribute SourceFile

# ── Capacitor keep rules ────────────────────────────────────────────────────
# Not active today: buildTypes.release sets minifyEnabled false (see
# build.gradle for why). They are written down here so that turning shrinking
# on later is a one-line change plus a device smoke test, rather than a
# debugging session over a release build that fails only on real hardware.
#
# Capacitor resolves plugins by reflection from the @CapacitorPlugin
# annotation, so R8 sees no callers and would strip them.
-keep public class com.getcapacitor.** { *; }
-keep @com.getcapacitor.annotation.CapacitorPlugin public class * { *; }
-keep public class * extends com.getcapacitor.Plugin { *; }
-keepclassmembers class * { @com.getcapacitor.PluginMethod public *; }
-keepattributes *Annotation*, Signature, InnerClasses, EnclosingMethod
