#!/bin/sh
# Run before publishing changes to partner/admin/agency pages so browsers fetch the new files.
V=$(date +%s)
sed -i -E "s#(portal|partner|admin|config)\.js(\?v=[0-9]+)?\"#\1.js?v=$V\"#g; s#portal\.css(\?v=[0-9]+)?\"#portal.css?v=$V\"#g" partner.html admin.html agency.html
echo "Version $V"
