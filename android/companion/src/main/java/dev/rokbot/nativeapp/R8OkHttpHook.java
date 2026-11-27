package dev.rokbot.nativeapp;

import android.content.Context;
import android.util.Log;
import java.lang.reflect.Field;
import java.lang.reflect.Proxy;
import java.util.Collections;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.SynchronousQueue;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;

/**
 * Installs R8OkHttpInterceptor into R8-obfuscated OkHttp factories (t8.f and Ae.k) in ai.x.grok.bot 1.16.0+.
 */
public final class R8OkHttpHook {
    private static final String TAG = "RokBotR8OkHttpHook";
    private static volatile R8OkHttpInterceptor sInterceptor;
    private static volatile oj.A sHookedClient;
    private static volatile oj.A sHookedFsClient;
    private static final ExecutorService sSharedPool = new ThreadPoolExecutor(
            0, Integer.MAX_VALUE, 60L, TimeUnit.SECONDS, new SynchronousQueue<>(),
            r -> {
                Thread t = new Thread(r, "OkHttp Dispatcher");
                t.setDaemon(false);
                return t;
            });
    private static final ExecutorService sNonShutdownExecutor = (ExecutorService) Proxy.newProxyInstance(
            ExecutorService.class.getClassLoader(),
            new Class<?>[]{ExecutorService.class},
            (proxy, method, args) -> {
                String name = method.getName();
                if ("shutdown".equals(name)) {
                    return null;
                }
                if ("shutdownNow".equals(name)) {
                    return Collections.emptyList();
                }
                if ("isShutdown".equals(name) || "isTerminated".equals(name)) {
                    return Boolean.FALSE;
                }
                if ("awaitTermination".equals(name)) {
                    return Boolean.TRUE;
                }
                try {
                    return method.invoke(sSharedPool, args);
                } catch (java.lang.reflect.InvocationTargetException ite) {
                    throw ite.getCause() != null ? ite.getCause() : ite;
                }
            });

    private static final java.util.Set<oj.A> sTrackedClients =
            java.util.Collections.synchronizedSet(java.util.Collections.newSetFromMap(new java.util.WeakHashMap<>()));

    private R8OkHttpHook() {}

    public static synchronized void install(Context context) {
        install(context, false);
    }

    public static synchronized void refresh(Context context) {
        install(context, true);
    }

    public static void evictConnections() {
        if (R8OkHttpHook127.isAvailable()) {
            R8OkHttpHook127.evictConnections();
            return;
        }
        if (R8OkHttpHook126.isAvailable()) {
            R8OkHttpHook126.evictConnections();
            return;
        }
        java.util.List<oj.A> snapshot = new java.util.ArrayList<>();
        oj.A primary = sHookedClient;
        oj.A fs = sHookedFsClient;
        if (primary != null) snapshot.add(primary);
        if (fs != null) snapshot.add(fs);
        synchronized (sTrackedClients) {
            snapshot.addAll(sTrackedClients);
        }
        for (oj.A client : snapshot) {
            evictConnectionPool(client);
        }
    }

    private static synchronized void install(Context context, boolean forceRefresh) {
        if (context == null) return;
        if (R8OkHttpHook127.isAvailable()) {
            if (forceRefresh) {
                R8OkHttpHook127.refresh(context);
            } else {
                R8OkHttpHook127.install(context);
            }
            return;
        }
        if (R8OkHttpHook126.isAvailable()) {
            if (forceRefresh) {
                R8OkHttpHook126.refresh(context);
            } else {
                R8OkHttpHook126.install(context);
            }
            return;
        }
        try {
            if (sInterceptor == null) {
                sInterceptor = new R8OkHttpInterceptor(context);
            }

            try {
                Class<?> factoryCls = Class.forName("t8.f");
                Field clientField = factoryCls.getDeclaredField("b");
                clientField.setAccessible(true);

                Object current = clientField.get(null);
                boolean skipPrimary = !forceRefresh && current != null
                        && (current == sHookedClient || (current instanceof oj.A && hasOurInterceptor((oj.A) current)));
                if (skipPrimary) {
                    if (current instanceof oj.A) {
                        sHookedClient = (oj.A) current;
                        sTrackedClients.add(sHookedClient);
                    }
                } else {
                    if (forceRefresh && current instanceof oj.A) {
                        evictConnectionPool((oj.A) current);
                    }
                    oj.A.a builder;
                    if (!forceRefresh && current instanceof oj.A) {
                        builder = ((oj.A) current).C();
                    } else {
                        builder = new oj.A.a()
                                .f(0L, TimeUnit.MILLISECONDS)
                                .P(0L, TimeUnit.MILLISECONDS)
                                .Q(0L, TimeUnit.MILLISECONDS)
                                .g(new t8.k());
                    }
                    oj.A hooked = builder.a(sInterceptor).c();
                    installExecutorGuard(hooked);
                    clientField.set(null, hooked);
                    sHookedClient = hooked;
                    sTrackedClients.add(hooked);
                }
            } catch (NoClassDefFoundError | ClassNotFoundException ignored) {
                // Target APK is un-obfuscated / synthetic test-target without R8 t8.f
            } catch (Throwable t) {
                Log.w(TAG, "Failed to install R8 OkHttp hook on t8.f", t);
            }

            // Also hook Expo FileSystem / module / standalone R8 OkHttpClient fields that bypass t8.f.b.
            oj.A fsWrapped = wrapStaticClientField("Ae.k", "a", forceRefresh);
            if (fsWrapped != null) {
                sHookedFsClient = fsWrapped;
            }
            wrapStaticClientField("expo.modules.filesystem.FileSystemDownloadTask", "k", forceRefresh);
            wrapStaticClientField("expo.modules.filesystem.FileSystemUploadTask", "h", forceRefresh);
            wrapStaticClientField("b8.a", "b", forceRefresh);
            wrapStaticClientField("b8.a", "c", forceRefresh);

            if (forceRefresh) {
                synchronized (sTrackedClients) {
                    for (oj.A tracked : sTrackedClients) {
                        evictConnectionPool(tracked);
                    }
                }
            }
        } catch (Throwable t) {
            Log.w(TAG, "Failed to install R8 OkHttp hook", t);
        }
    }

    private static oj.A wrapStaticClientField(String className, String fieldName, boolean forceRefresh) {
        try {
            Class<?> cls = Class.forName(className);
            Field field = cls.getDeclaredField(fieldName);
            field.setAccessible(true);
            Object current = field.get(null);
            if (current instanceof oj.A) {
                oj.A cur = (oj.A) current;
                sTrackedClients.add(cur);
                if (hasOurInterceptor(cur)) {
                    if (forceRefresh) {
                        evictConnectionPool(cur);
                    }
                    return cur;
                }
                oj.A wrapped = cur.C().a(sInterceptor).c();
                installExecutorGuard(wrapped);
                field.set(null, wrapped);
                sTrackedClients.add(wrapped);
                return wrapped;
            }
        } catch (Throwable ignored) {}
        return null;
    }

    public static synchronized void hookReactContext(Context context, Object reactContext) {
        if (reactContext == null) return;
        if (R8OkHttpHook127.isAvailable()) {
            R8OkHttpHook127.hookReactContext(context, reactContext);
            return;
        }
        if (R8OkHttpHook126.isAvailable()) {
            R8OkHttpHook126.hookReactContext(context, reactContext);
            return;
        }
        if (sInterceptor == null && context != null) {
            sInterceptor = new R8OkHttpInterceptor(context);
        }
        if (sInterceptor == null) return;
        java.util.IdentityHashMap<Object, Boolean> seen = new java.util.IdentityHashMap<>();
        try {
            // Inspect NativeModulesProxy / Expo ModuleRegistry if present to wrap Ce.k / Lc.d / xg.B0 oj.A fields.
            java.lang.reflect.Method getNativeModules = reactContext.getClass().getMethod("getNativeModules");
            getNativeModules.setAccessible(true);
            Object modulesObj = getNativeModules.invoke(reactContext);
            if (modulesObj instanceof java.util.Collection<?>) {
                for (Object mod : (java.util.Collection<?>) modulesObj) {
                    if (mod == null) continue;
                    String clsName = mod.getClass().getName();
                    if (!clsName.contains("NativeModulesProxy") && !clsName.contains("expo.modules")
                            && !isInterestingExpoObject(mod)) {
                        continue;
                    }
                    scanAndWrapExpoClients(mod, 0, seen);
                }
            }
        } catch (Throwable ignored) {}
        try {
            java.lang.reflect.Method getNativeModule = reactContext.getClass().getMethod("getNativeModule", String.class);
            getNativeModule.setAccessible(true);
            Object unimodule = getNativeModule.invoke(reactContext, "NativeUnimoduleProxy");
            if (unimodule != null) {
                scanAndWrapExpoClients(unimodule, 0, seen);
            }
        } catch (Throwable ignored) {}
    }

    private static void scanAndWrapExpoClients(Object obj, int depth, java.util.IdentityHashMap<Object, Boolean> seen) {
        if (obj == null || depth > 6 || seen.containsKey(obj)) return;
        seen.put(obj, Boolean.TRUE);
        Class<?> cls = obj.getClass();
        String pkg = cls.getName();
        if (pkg.startsWith("android.") || pkg.startsWith("java.") || pkg.startsWith("javax.")) return;
        boolean allowPopulateNullClient = "Ce.k".equals(pkg) || "xg.B0".equals(pkg) || "Lc.d".equals(pkg);
        while (cls != null && cls != Object.class) {
            for (Field f : cls.getDeclaredFields()) {
                try {
                    f.setAccessible(true);
                    boolean isStatic = java.lang.reflect.Modifier.isStatic(f.getModifiers());
                    Object val = f.get(isStatic ? null : obj);
                    if (val instanceof oj.A) {
                        oj.A cur = (oj.A) val;
                        sTrackedClients.add(cur);
                        if (!hasOurInterceptor(cur)) {
                            oj.A wrapped = cur.C().a(sInterceptor).c();
                            installExecutorGuard(wrapped);
                            f.set(isStatic ? null : obj, wrapped);
                            sTrackedClients.add(wrapped);
                        }
                    } else if (!isStatic && allowPopulateNullClient && val == null
                            && f.getType() == oj.A.class && sHookedClient != null) {
                        f.set(obj, sHookedClient);
                    } else if (val != null && depth < 6) {
                        if (val instanceof java.util.Map<?, ?>) {
                            for (Object entryVal : ((java.util.Map<?, ?>) val).values()) {
                                if (isInterestingExpoObject(entryVal)) {
                                    scanAndWrapExpoClients(entryVal, depth + 1, seen);
                                }
                            }
                        } else if (val instanceof java.util.Collection<?>) {
                            for (Object elem : (java.util.Collection<?>) val) {
                                if (isInterestingExpoObject(elem)) {
                                    scanAndWrapExpoClients(elem, depth + 1, seen);
                                }
                            }
                        } else if (isInterestingExpoObject(val)) {
                            scanAndWrapExpoClients(val, depth + 1, seen);
                        }
                    }
                } catch (Throwable ignored) {}
            }
            cls = cls.getSuperclass();
        }
    }

    private static boolean isInterestingExpoObject(Object val) {
        if (val == null) return false;
        String name = val.getClass().getName();
        return name.startsWith("expo.modules.")
                || name.startsWith("bf.")
                || name.startsWith("me.")
                || name.startsWith("Ce.")
                || name.startsWith("Lc.")
                || name.startsWith("xg.")
                || name.startsWith("Bg.")
                || name.startsWith("pf.")
                || name.startsWith("of.")
                || name.startsWith("yf.");
    }

    private static boolean hasOurInterceptor(oj.A client) {
        if (client == null) return false;
        try {
            Object listObj = null;
            try {
                listObj = client.getClass().getMethod("z").invoke(client);
            } catch (Throwable ignored) {
                Field f = client.getClass().getDeclaredField("c");
                f.setAccessible(true);
                listObj = f.get(client);
            }
            if (listObj instanceof java.util.List<?>) {
                for (Object item : (java.util.List<?>) listObj) {
                    if (item instanceof R8OkHttpInterceptor || item == sInterceptor) {
                        return true;
                    }
                }
            }
        } catch (Throwable ignored) {}
        return false;
    }

    private static void evictConnectionPool(oj.A client) {
        if (client == null) return;
        try {
            Object pool = null;
            try {
                pool = client.getClass().getMethod("n").invoke(client);
            } catch (Throwable ignored) {
                Field f = client.getClass().getDeclaredField("b");
                f.setAccessible(true);
                pool = f.get(client);
            }
            if (pool != null) {
                pool.getClass().getMethod("a").invoke(pool);
            }
        } catch (Throwable ignored) {}
    }

    private static void installExecutorGuard(oj.A client) {
        if (client == null) return;
        try {
            Field dispField = client.getClass().getDeclaredField("a");
            dispField.setAccessible(true);
            Object disp = dispField.get(client);
            if (disp != null) {
                Field execField = disp.getClass().getDeclaredField("d");
                execField.setAccessible(true);
                execField.set(disp, sNonShutdownExecutor);
            }
        } catch (Throwable t) {
            Log.w(TAG, "Unable to guard Dispatcher executor", t);
        }
    }
}
