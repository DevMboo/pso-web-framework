package com.pso.it.app;

import java.util.Map;
import org.springframework.http.MediaType;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.multipart.MultipartFile;

/** Maps WITHOUT the service prefix: PSO adds it. */
@RestController
@RequestMapping("/customers")
public class CustomerController {

    @GetMapping("/{id}")
    public Map<String, String> find(@PathVariable String id) {
        return Map.of("id", id);
    }

    @GetMapping("/slow")
    public Map<String, String> slow() throws InterruptedException {
        Thread.sleep(700);
        return Map.of("slow", "done");
    }

    @PostMapping(consumes = MediaType.APPLICATION_JSON_VALUE)
    public Map<String, Integer> create(@RequestBody String body) {
        return Map.of("length", body.length());
    }

    @PostMapping(value = "/upload", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    public Map<String, Long> upload(@RequestParam("file") MultipartFile file) {
        return Map.of("size", file.getSize());
    }

    @DeleteMapping("/{id}")
    @PreAuthorize("hasAuthority('SCOPE_customers:admin')")
    public Map<String, String> delete(@PathVariable String id) {
        return Map.of("deleted", id);
    }
}
