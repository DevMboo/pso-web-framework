package com.pso.spring.storage;

import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.SerializationFeature;
import com.fasterxml.jackson.datatype.jsr310.JavaTimeModule;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Persistence of {@link StoredFile} records, behind an interface so a service chooses where they live without a shared database:
 * next to the files ({@link ProviderBacked}, the default), in memory (tests), or in the service's own database (implement this interface
 * with JPA/JDBC and register a bean: the framework backs off).
 */
public interface FileMetadataStore {

    void save(StoredFile file);

    Optional<StoredFile> find(String id);

    /** Idempotent. */
    void delete(String id);

    /** One page of files matching the filter, in id order. The cursor is opaque. */
    Page list(Filter filter, String cursor, int limit);

    record Filter(String ownerRef, String namespacePrefix) {
        public static final Filter ALL = new Filter(null, null);

        boolean matches(StoredFile f) {
            return (ownerRef == null || ownerRef.equals(f.ownerRef()))
                && (namespacePrefix == null || f.key().startsWith(namespacePrefix + "/"));
        }
    }

    record Page(List<StoredFile> items, String nextCursor) {
    }

    /** Keeps each record as a small JSON object under the reserved {@code _pso/files/} prefix of the same provider: no extra infrastructure. */
    final class ProviderBacked implements FileMetadataStore {
        static final String PREFIX = StorageKeys.INTERNAL_PREFIX + "/files/";
        private static final ObjectMapper JSON = new ObjectMapper()
            .registerModule(new JavaTimeModule())
            .disable(SerializationFeature.WRITE_DATES_AS_TIMESTAMPS)
            .disable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES);
        private final StorageProvider provider;

        public ProviderBacked(StorageProvider provider) {
            this.provider = provider;
        }

        private static String keyOf(String id) {
            return PREFIX + id + ".json";
        }

        @Override
        public void save(StoredFile file) {
            try {
                byte[] json = JSON.writeValueAsBytes(file);
                provider.replace(keyOf(file.id()), new ByteArrayInputStream(json), json.length, "application/json", Map.of());
            } catch (IOException e) {
                throw new StorageException.Unavailable("cannot write file metadata", e);
            }
        }

        @Override
        public Optional<StoredFile> find(String id) {
            if (!StoragePolicyHelpers.validId(id)) {
                return Optional.empty();
            }
            try (InputStream in = provider.get(keyOf(id))) {
                return Optional.of(JSON.readValue(in, StoredFile.class));
            } catch (StorageException.NotFound e) {
                return Optional.empty();
            } catch (IOException e) {
                throw new StorageException.Unavailable("cannot read file metadata", e);
            }
        }

        @Override
        public void delete(String id) {
            if (StoragePolicyHelpers.validId(id)) {
                provider.delete(keyOf(id));
            }
        }

        @Override
        public Page list(Filter filter, String cursor, int limit) {
            List<StoredFile> out = new ArrayList<>();
            String next = cursor;
            // a page may hold fewer than `limit` records (non-matching ones are skipped); keep reading until something matches or the listing ends
            for (int i = 0; i < 20; i++) {
                StorageProvider.ObjectPage page = provider.list(PREFIX, next, limit);
                for (StorageProvider.ObjectInfo o : page.items()) {
                    String name = o.key().substring(PREFIX.length());
                    if (!name.endsWith(".json")) {
                        continue;
                    }
                    Optional<StoredFile> f = find(name.substring(0, name.length() - 5));
                    if (f.isPresent() && filter.matches(f.get())) {
                        out.add(f.get());
                    }
                }
                next = page.nextCursor();
                if (!out.isEmpty() || next == null) {
                    break;
                }
            }
            return new Page(out, next);
        }
    }

    /** For tests and throwaway services. Not shared between instances and lost on restart. */
    class InMemory implements FileMetadataStore {
        private final Map<String, StoredFile> files = new ConcurrentHashMap<>();

        @Override
        public void save(StoredFile file) {
            files.put(file.id(), file);
        }

        @Override
        public Optional<StoredFile> find(String id) {
            return Optional.ofNullable(id == null ? null : files.get(id));
        }

        @Override
        public void delete(String id) {
            if (id != null) {
                files.remove(id);
            }
        }

        @Override
        public Page list(Filter filter, String cursor, int limit) {
            List<StoredFile> all = files.values().stream().filter(filter::matches).filter(f -> cursor == null || f.id().compareTo(cursor) > 0)
                .sorted(java.util.Comparator.comparing(StoredFile::id)).limit((long) limit + 1).toList();
            if (all.size() > limit) {
                List<StoredFile> items = all.subList(0, limit);
                return new Page(items, items.get(limit - 1).id());
            }
            return new Page(all, null);
        }
    }

    /** Small helpers shared by the stores (public identifier syntax). */
    final class StoragePolicyHelpers {
        private static final java.util.regex.Pattern ID = java.util.regex.Pattern.compile("^f_[A-Za-z0-9_-]{22}$");

        private StoragePolicyHelpers() {
        }

        static boolean validId(String id) {
            return id != null && ID.matcher(id).matches();
        }
    }
}
