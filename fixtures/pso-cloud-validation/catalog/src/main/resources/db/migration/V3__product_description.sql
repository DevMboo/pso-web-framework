-- expand step: a nullable column. The previous release does not know it and keeps working while this one starts.
ALTER TABLE products ADD COLUMN description VARCHAR(500);
