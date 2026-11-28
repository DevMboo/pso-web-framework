# Edge gateway image of the PSO infrastructure engine (@pso/infra). It is built on the developer's or operator's machine from the
# installed framework (never pulled from a registry); its tag is the SHA-256 of this build context, so a configuration rendered by one
# PSO release always runs on the image of that same release. The error pages and their configuration are generated into the build
# context by the engine (src/edge.ts) and exist only inside the image: never in a workspace, a FEI, a MEI or .infra/.
#
# nginx and headers-more (BSD-2-Clause) are Alpine's own packages from the security-maintained main repository, built together for the
# same nginx release. headers-more is what removes the Server header: `server_tokens off` only hides the version.
#
# Reproducibility: the base is pinned by digest; the packages are pinned to the nginx 1.30 branch of Alpine 3.24 (the only branch that
# release ships), not to one build: Alpine keeps only the newest build of a package in a stable branch, so an exact pin would stop
# building as soon as Alpine ships a security fix. The build fails if the branch or the configuration is not what PSO expects, and it
# records the exact package builds in /usr/share/edge/packages.txt. Once built, an image is reused as long as its tag exists; a PSO
# release that changes any input here produces a new tag and therefore a fresh build with Alpine's current fixes.
FROM alpine:3.24@sha256:f59abe656b692d901e184be3445e084786602108599d2a51d229c0f5a48c71bf
RUN apk add --no-cache "nginx~1.30" "nginx-mod-http-headers-more~1.30" \
 && rm -rf /etc/nginx/http.d /etc/nginx/modules/*.conf /usr/share/nginx /var/www \
 && mkdir -p /etc/nginx/conf.d
COPY nginx.conf /etc/nginx/nginx.conf
COPY conf/ /etc/nginx/edge/
COPY errors/ /usr/share/edge/errors/
RUN chmod -R a+rX /etc/nginx /usr/share/edge \
 && nginx -V 2>&1 | grep -q "nginx/1\.30\." \
 && nginx -e stderr -t \
 && apk info -e -v nginx nginx-mod-http-headers-more | sort > /usr/share/edge/packages.txt
EXPOSE 8443
STOPSIGNAL SIGQUIT
CMD ["nginx", "-e", "stderr", "-g", "daemon off;"]
