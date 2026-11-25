import com.sun.net.httpserver.HttpServer;
import java.net.InetSocketAddress;
import java.nio.file.Files;
import java.nio.file.Path;

/** Fixture Java microservice: the JDK's built-in HTTP server, a readiness endpoint and a graceful shutdown hook. */
public class Main {
  public static void main(String[] args) throws Exception {
    int port = Integer.parseInt(System.getenv("PORT"));
    String version = Files.readString(Path.of("version.txt")).trim();
    HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", port), 0);
    server.createContext("/health/ready", ex -> { byte[] b = ("{\"ok\":true,\"version\":\"" + version + "\"}").getBytes(); ex.sendResponseHeaders(200, b.length); ex.getResponseBody().write(b); ex.close(); });
    server.createContext("/items", ex -> { byte[] b = ("{\"version\":\"" + version + "\",\"items\":[\"a\",\"b\"]}").getBytes(); ex.getResponseHeaders().add("content-type", "application/json"); ex.sendResponseHeaders(200, b.length); ex.getResponseBody().write(b); ex.close(); });
    server.start();
    System.out.println("catalog " + version + " listening on " + port);
    Runtime.getRuntime().addShutdownHook(new Thread(() -> { System.out.println("catalog: shutting down"); server.stop(2); }));
  }
}
