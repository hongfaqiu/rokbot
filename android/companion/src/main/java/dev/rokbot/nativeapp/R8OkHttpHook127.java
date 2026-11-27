package dev.rokbot.nativeapp;

import android.content.Context;
import android.util.Log;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;

/**
 * Installs R8OkHttpInterceptor127 into R8-obfuscated OkHttp factories (L9.f, Zg.k, t9.a, Xi.B0, bh.k)
 * in ai.x.grok.bot 1.27.0+ (build 3283).
 */
public final class R8OkHttpHook127 {
    private static final String TAG = "RokBotR8OkHttpHook127";
    private static volatile R8OkHttpInterceptor127 sInterceptor;
    private static volatile Xl.B sHookedClient;
    private static volatile Xl.B sHookedFsClient;
    private static final ExecutorService sSharedPool = new ThreadPoolExecutor(
            0, 64, 60L, TimeUnit.SECONDS, new LinkedBlockingQueue<>(),
            r -> {
                Thread t = new Thread(r, "RokBotOkHttpDispatcher");
                t.setDaemon(false);
                return t;
            });
    private static final ExecutorService sNonShutdownExecutor = (ExecutorService) Proxy.newProxyInstance(
            R8OkHttpHook127.class.getClassLoader(),
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
                return method.invoke(sSharedPool, args);
            });
    private static final java.util.Set<Xl.B> sTrackedClients =
            Collections.synchronizedSet(Collections.newSetFromMap(new java.util.IdentityHashMap<>()));

    private R8OkHttpHook127() {}

    public static synchronized void install(Context context) {
        install(context, false);
    }

    public static synchronized void refresh(Context context) {
        install(context, true);
    }

    public static void evictConnections() {
        java.util.List<Xl.B> snapshot = new java.util.ArrayList<>();
        Xl.B primary = sHookedClient;
        Xl.B fs = sHookedFsClient;
        if (primary != null) snapshot.add(primary);
        if (fs != null) snapshot.add(fs);
        synchronized (sTrackedClients) {
            snapshot.addAll(sTrackedClients);
        }
        for (Xl.B client : snapshot) {
            evictConnectionPool(client);
        }
    }

    public static boolean isAvailable() {
        try {
            Class.forName("t8.f");
            Class.forName("oj.A");
            return false;
        } catch (Throwable ignored) {
        }
        try {
            Class.forName("L9.f");
            Class.forName("Xl.B");
            return true;
        } catch (Throwable ignored) {
            return false;
        }
    }

    private static synchronized void install(Context context, boolean forceRefresh) {
        if (context == null) return;
        if (sInterceptor == null) {
            sInterceptor = new R8OkHttpInterceptor127(context.getApplicationContext());
        }
        try {
            Class<?> factoryCls = Class.forName("L9.f");
            Field bField = factoryCls.getDeclaredField("b");
            bField.setAccessible(true);
            Object current = bField.get(null);

            boolean alreadyInstalled = !forceRefresh
                    && current != null
                    && (current == sHookedClient || (current instanceof Xl.B && hasOurInterceptor((Xl.B) current)));
            if (alreadyInstalled) {
                if (current instanceof Xl.B) {
                    sHookedClient = (Xl.B) current;
                    sTrackedClients.add((Xl.B) current);
                    installExecutorGuard((Xl.B) current);
                }
            } else {
                if (forceRefresh && current instanceof Xl.B) {
                    evictConnectionPool((Xl.B) current);
                }
                Xl.B.a builder;
                if (!forceRefresh && current instanceof Xl.B) {
                    builder = ((Xl.B) current).E();
                } else {
                    builder = new Xl.B.a()
                            .f(15000L, TimeUnit.MILLISECONDS)
                            .Q(60000L, TimeUnit.MILLISECONDS)
                            .R(60000L, TimeUnit.MILLISECONDS)
                            .g(new L9.k());
                }
                Xl.B hooked = builder.a(sInterceptor).c();
                installExecutorGuard(hooked);
                bField.set(null, hooked);
                sHookedClient = hooked;
                sTrackedClients.add(hooked);
                Log.i(TAG, (forceRefresh ? "Refreshed" : "Installed") + " R8 OkHttp interceptor on L9.f.b");
            }
        } catch (Throwable t) {
            Log.w(TAG, "Failed to install R8 OkHttp hook on L9.f", t);
        }

        // Also hook Expo FileSystem / module / standalone R8 Xl.B fields that bypass L9.f.b.
        Xl.B fsWrapped = wrapStaticClientField("Zg.k", "a", forceRefresh);
        if (fsWrapped != null) {
            sHookedFsClient = fsWrapped;
        }
        wrapStaticClientField("t9.a", "b", forceRefresh);
        wrapStaticClientField("t9.a", "c", forceRefresh);
        if (forceRefresh) {
            synchronized (sTrackedClients) {
                for (Xl.B tracked : sTrackedClients) {
                    evictConnectionPool(tracked);
                    installExecutorGuard(tracked);
                }
            }
        }
    }

    private static Xl.B wrapStaticClientField(String className, String fieldName, boolean forceRefresh) {
        try {
            Class<?> cls = Class.forName(className);
            Field f = cls.getDeclaredField(fieldName);
            f.setAccessible(true);
            Object current = f.get(null);
            if (current instanceof Xl.B) {
                Xl.B cur = (Xl.B) current;
                if (forceRefresh) {
                    evictConnectionPool(cur);
                }
                if (hasOurInterceptor(cur)) {
                    installExecutorGuard(cur);
                    sTrackedClients.add(cur);
                    return cur;
                }
                Xl.B wrapped = cur.E().a(sInterceptor).c();
                installExecutorGuard(wrapped);
                f.set(null, wrapped);
                sTrackedClients.add(wrapped);
                Log.i(TAG, "Wrapped standalone R8 OkHttpClient at " + className + "." + fieldName);
                return wrapped;
            }
        } catch (Throwable ignored) {}
        return null;
    }

    public static synchronized void hookReactContext(Context context, Object reactContext) {
        if (context == null || reactContext == null) return;
        install(context, false);
        try {
            java.util.IdentityHashMap<Object, Boolean> seen = new java.util.IdentityHashMap<>();
            scanAndWrapExpoClients(reactContext, 0, seen);
        } catch (Throwable ignored) {}
    }

    private static void scanAndWrapExpoClients(Object obj, int depth, java.util.IdentityHashMap<Object, Boolean> seen) {
        if (obj == null || depth > 5 || seen.containsKey(obj)) return;
        seen.put(obj, Boolean.TRUE);
        Class<?> cls = obj.getClass();
        String clsName = cls.getName();
        boolean allowPopulateNullClient = "Zg.k".equals(clsName) || "Xi.B0".equals(clsName)
                || "bh.k".equals(clsName) || "t9.a".equals(clsName);
        for (Class<?> curCls = cls; curCls != null && curCls != Object.class; curCls = curCls.getSuperclass()) {
            for (Field f : curCls.getDeclaredFields()) {
                try {
                    if (java.lang.reflect.Modifier.isStatic(f.getModifiers())) continue;
                    f.setAccessible(true);
                    Object val = f.get(obj);
                    if (val instanceof Xl.B) {
                        Xl.B cur = (Xl.B) val;
                        if (!hasOurInterceptor(cur)) {
                            Xl.B wrapped = cur.E().a(sInterceptor).c();
                            installExecutorGuard(wrapped);
                            f.set(obj, wrapped);
                            sTrackedClients.add(wrapped);
                            Log.i(TAG, "Wrapped instance OkHttpClient at " + clsName + "." + f.getName());
                        }
                    } else if (val == null && allowPopulateNullClient
                            && f.getType() == Xl.B.class && sHookedClient != null) {
                        f.set(obj, sHookedClient);
                        Log.i(TAG, "Populated null OkHttpClient at " + clsName + "." + f.getName());
                    } else if (val instanceof java.util.Map<?, ?>) {
                        for (Object mv : ((java.util.Map<?, ?>) val).values()) {
                            if (isInterestingExpoObject(mv)) {
                                scanAndWrapExpoClients(mv, depth + 1, seen);
                            }
                        }
                    } else if (val instanceof java.util.Collection<?>) {
                        for (Object cv : (java.util.Collection<?>) val) {
                            if (isInterestingExpoObject(cv)) {
                                scanAndWrapExpoClients(cv, depth + 1, seen);
                            }
                        }
                    } else if (isInterestingExpoObject(val)) {
                        scanAndWrapExpoClients(val, depth + 1, seen);
                    }
                } catch (Throwable ignored) {}
            }
        }
    }

    private static boolean isInterestingExpoObject(Object val) {
        if (val == null) return false;
        String n = val.getClass().getName();
        return n.startsWith("expo.modules.")
                || n.startsWith("com.facebook.react.")
                || n.startsWith("Zg.")
                || n.startsWith("Xi.")
                || n.startsWith("bh.")
                || n.startsWith("t9.")
                || n.startsWith("L9.")
                || n.startsWith("Nh.");
    }

    private static boolean hasOurInterceptor(Xl.B client) {
        if (client == null) return false;
        try {
            Method m = Xl.B.class.getMethod("B");
            Object res = m.invoke(client);
            if (res instanceof List<?>) {
                for (Object item : (List<?>) res) {
                    if (item instanceof R8OkHttpInterceptor127
                            || (item != null && R8OkHttpInterceptor127.class.getName().equals(item.getClass().getName()))) {
                        return true;
                    }
                }
            }
        } catch (Throwable ignored) {}
        try {
            Field f = Xl.B.class.getDeclaredField("c");
            f.setAccessible(true);
            Object res = f.get(client);
            if (res instanceof List<?>) {
                for (Object item : (List<?>) res) {
                    if (item instanceof R8OkHttpInterceptor127) return true;
                }
            }
        } catch (Throwable ignored) {}
        return false;
    }

    private static void evictConnectionPool(Xl.B client) {
        if (client == null) return;
        try {
            Object pool = Xl.B.class.getMethod("q").invoke(client);
            if (pool != null) {
                pool.getClass().getMethod("a").invoke(pool);
            }
        } catch (Throwable ignored) {}
        try {
            Field poolField = Xl.B.class.getDeclaredField("b");
            poolField.setAccessible(true);
            Object pool = poolField.get(client);
            if (pool != null) {
                pool.getClass().getMethod("a").invoke(pool);
            }
        } catch (Throwable ignored) {}
    }

    private static void installExecutorGuard(Xl.B client) {
        if (client == null) return;
        try {
            Object dispatcher = null;
            try {
                dispatcher = Xl.B.class.getMethod("u").invoke(client);
            } catch (Throwable ignored) {}
            if (dispatcher == null) {
                Field dispField = Xl.B.class.getDeclaredField("a");
                dispField.setAccessible(true);
                dispatcher = dispField.get(client);
            }
            if (dispatcher != null) {
                Field execField = dispatcher.getClass().getDeclaredField("d");
                execField.setAccessible(true);
                if (execField.get(dispatcher) != sNonShutdownExecutor) {
                    execField.set(dispatcher, sNonShutdownExecutor);
                }
            }
        } catch (Throwable ignored) {}
    }
}
