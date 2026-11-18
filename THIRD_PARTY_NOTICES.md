# Third-Party Notices

Flying draws incorporates or distributes third-party open-source software and font assets listed below.
For Electron and Chromium component notices in packaged desktop distributions, see `LICENSE.electron.txt` and `LICENSES.chromium.html`.

---

## 1. Runtime & Renderer Libraries

| Component | License | Copyright / Upstream |
|---|---|---|
| `@excalidraw/excalidraw` & `@excalidraw/*` | MIT | Copyright (c) 2020 Excalidraw |
| `react`, `react-dom`, `scheduler` | MIT | Copyright (c) Meta Platforms, Inc. and affiliates. |
| `@modelcontextprotocol/sdk` | MIT | Copyright (c) 2024 Anthropic, PBC |
| `@dagrejs/dagre`, `@dagrejs/graphlib`, `dagre-d3-es` | MIT | Copyright (c) Chris Pettitt and contributors |
| `koffi`, `@koromix/koffi-win32-x64` | MIT | Copyright (c) Niels Martignène |
| `zod`, `zod-to-json-schema` | MIT / ISC | Copyright (c) Colin McDonnell / Stefan Terdell |
| `roughjs`, `points-on-curve`, `points-on-path` | MIT | Copyright (c) Preet Shihn |
| `perfect-freehand` | MIT | Copyright (c) Steve Ruiz |
| `jotai`, `zustand` | MIT | Copyright (c) Daishi Kato / Paul Henschel |
| `@radix-ui/*`, `@floating-ui/*` | MIT | Copyright (c) WorkOS / Floating UI contributors |
| `mermaid`, `cytoscape`, `katex`, `marked`, `lodash-es`, `es-toolkit`, `dayjs`, `pica`, `image-blob-reduce`, `open-color`, `langium`, `fuzzy`, `khroma` | MIT | Respective authors and contributors |
| `express`, `hono`, `@hono/node-server`, `jose`, `ajv`, `ajv-formats`, `cors`, `eventsource`, `eventsource-parser`, `pkce-challenge`, `cross-spawn`, `debug` | MIT | Respective authors and contributors |
| `dompurify` | Apache-2.0 *(elected from MPL-2.0 OR Apache-2.0)* | Copyright (c) 2015 Mario Heiderich / Cure53 |
| `chevrotain`, `@chevrotain/*` | Apache-2.0 | Copyright (c) SAP SE |
| `browser-fs-access`, `pwacompat` | Apache-2.0 | Copyright (c) Google LLC |
| `crc-32` | Apache-2.0 | Copyright (c) SheetJS LLC |
| `d3` & `d3-*`, `delaunator`, `internmap`, `inherits`, `isexe`, `once`, `setprototypeof`, `which`, `wrappy` | ISC / BSD-3-Clause | Copyright (c) Mike Bostock, Mapbox, Isaac Z. Schlueter, and contributors |
| `fast-uri`, `qs`, `rw`, `source-map-js` | BSD-3-Clause | Respective authors and contributors |
| `json-schema-typed` | BSD-2-Clause | Copyright (c) Remy Rylan |
| `pako` | MIT AND Zlib | Copyright (c) Vitaly Puzrin and Andrey Tupitsin |
| `tslib`, `fractional-indexing`, `robust-predicates` | 0BSD / CC0-1.0 / Unlicense | Microsoft Corp. / Greenspan / Mourner |

---

## 2. Bundled Fonts (`public/fonts`)

| Font Family | License | Copyright & Reserved Font Name Notice |
|---|---|---|
| **Excalifont** | SIL OFL-1.1 | Copyright (c) 2024 by Excalidraw (`https://github.com/excalidraw/excalifont`). |
| **Virgil** | SIL OFL-1.1 | Copyright (c) 2011 by Your Own Font Foundry (Ellinor Rapp / Excalidraw), with Reserved Font Name `Virgil`. |
| **Xiaolai (小赖字体)** | SIL OFL-1.1 | Copyright (c) 2020 LXGW (`https://github.com/lxgw/kose-font`). |
| **Cascadia Code** | SIL OFL-1.1 | Copyright (c) 2020 Microsoft Corporation, with Reserved Font Name `Cascadia Code`. |
| **Assistant** | SIL OFL-1.1 | Copyright 2020 The Assistant Project Authors; Copyright 2010, 2012, 2014 Adobe Systems Incorporated (`Source` is a trademark of Adobe). |
| **Nunito** | SIL OFL-1.1 | Copyright 2014 The Nunito Project Authors (`https://github.com/googlefonts/nunito`). |
| **Lilita One** | SIL OFL-1.1 | Copyright (c) 2011 Juan Montoreano, with Reserved Font Name `Lilita One`. |
| **Comic Shanns** | MIT | Copyright (c) 2018 Shannon Miwa; 2023 Jesus Gonzalez; 2023 Rodrigo Batista de Moraes; 2024 Fini Jastrow; 2024 Kyle Beechly. |
| **Liberation Sans** (`v1.05`, Excalidraw fallback) | GPL-2.0-with-font-exception | Digitized data (c) 2007 Ascender Corporation. Liberation is a trademark of Red Hat, Inc. Upstream source: `https://github.com/liberationfonts/liberation-fonts` (distributed unmodified via `@excalidraw/excalidraw`). |

---

## 3. Prebuilt Fuxi Host Kernel Dependencies (`resources/fuxi`)

When distributed with the prebuilt `fuxi` / `fuxi.exe` host runtime (Copyright (c) 2026 Bofei Jian, MIT License), the binary statically links third-party Rust crates under permissive licenses:

| Crate Family | License | Copyright / Upstream |
|---|---|---|
| `tokio`, `tokio-util`, `tokio-native-tls`, `hyper`, `hyper-util`, `tower`, `tower-http`, `reqwest`, `mio`, `bytes` | MIT | Copyright (c) Tokio Contributors, Sean McArthur, and respective authors |
| `serde`, `serde_json`, `toml`, `toml_edit`, `clap`, `anyhow`, `thiserror`, `tracing`, `tracing-subscriber`, `regex`, `ignore`, `walkdir` | MIT OR Apache-2.0 | Copyright (c) Erick Tryzelaar, David Tolnay, Andrew Gallant, Clap Contributors, and respective authors |
| `ratatui`, `crossterm`, `syntect`, `pulldown-cmark`, `calamine`, `pdf-extract`, `png` | MIT | Copyright (c) Ratatui Developers, Timon Post, Tristan Hume, Raph Levien, and respective authors |
| `rustls`, `hyper-rustls` | Apache-2.0 OR ISC OR MIT | Copyright (c) Joseph Birr-Pixton and Rustls Contributors |
| `ring` | Apache-2.0 AND ISC | Copyright (c) 2015-2024 Brian Smith and contributors (includes BoringSSL/OpenSSL-derived code under ISC/OpenSSL-compatible terms) |
| `rustls-webpki`, `untrusted` | ISC | Copyright (c) Brian Smith |
| `encoding_rs` | (Apache-2.0 OR MIT) AND BSD-3-Clause | Copyright (c) 2015-2016 Mozilla Foundation |
| `subtle` | BSD-3-Clause | Copyright (c) 2016-2018 Isis Agora Lovecruft, Henry de Valence |
| `icu_*`, `litemap`, `tinystr`, `writeable`, `yoke`, `zerofrom`, `zerotrie`, `zerovec`, `unicode-ident`, `unicode-normalization` | Unicode-3.0 | Copyright (c) 2020-2025 Unicode, Inc. (`https://www.unicode.org/copyright.html`) |
| `zlib-rs`, `foldhash`, `miniz_oxide` | Zlib / MIT / Apache-2.0 | Copyright (c) Trifecta Tech Foundation, Orson Peters, and respective authors |
| `option-ext` | MPL-2.0 | Copyright (c) Simon Ochsenreither. Used unmodified; source code is available at `https://github.com/soc/option-ext` under Mozilla Public License 2.0 (`https://mozilla.org/MPL/2.0/`). |

---

## 4. License Texts

### MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

---

### ISC License

Permission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby granted, provided that the above copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.

---

### BSD 2-Clause & 3-Clause License

Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:
1. Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer.
2. Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the documentation and/or other materials provided with the distribution.
3. (3-Clause only) Neither the name of the copyright holder nor the names of its contributors may be used to endorse or promote products derived from this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

---

### Apache License, Version 2.0

Licensed under the Apache License, Version 2.0 (the "License"); you may not use these components except in compliance with the License. You may obtain a copy of the License at `http://www.apache.org/licenses/LICENSE-2.0`. Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.

---

### Zlib License

This software is provided 'as-is', without any express or implied warranty. In no event will the authors be held liable for any damages arising from the use of this software. Permission is granted to anyone to use this software for any purpose, including commercial applications, and to alter it and redistribute it freely, subject to the following restrictions:
1. The origin of this software must not be misrepresented; you must not claim that you wrote the original software. If you use this software in a product, an acknowledgment in the product documentation would be appreciated but is not required.
2. Altered source versions must be plainly marked as such, and must not be misrepresented as being the original software.
3. This notice may not be removed or altered from any source distribution.

---

### SIL Open Font License, Version 1.1

PREAMBLE
The goals of the Open Font License (OFL) are to stimulate worldwide development of collaborative font projects, to support the font creation efforts of academic and linguistic communities, and to provide a free and open framework in which fonts may be shared and improved in partnership with others.

The OFL allows the licensed fonts to be used, studied, modified and redistributed freely as long as they are not sold by themselves. The fonts, including any derivative works, can be bundled, embedded, redistributed and/or sold with any software provided that any reserved names are not used by derivative works. The fonts and derivatives, however, cannot be released under any other type of license. The requirement for fonts to remain under this license does not apply to any document created using the fonts or their derivatives.

DEFINITIONS
"Font Software" refers to the set of files released by the Copyright Holder(s) under this license and clearly marked as such. This may include source files, build scripts and documentation.
"Reserved Font Name" refers to any names specified as such after the copyright statement(s).
"Original Version" refers to the collection of Font Software components as distributed by the Copyright Holder(s).
"Modified Version" refers to any derivative made by adding to, deleting, or substituting -- in part or in whole -- any of the components of the Original Version, by changing formats or by porting the Font Software to a new environment.
"Author" refers to any designer, engineer, programmer, technical writer or other person who contributed to the Font Software.

PERMISSION & CONDITIONS
Permission is hereby granted, free of charge, to any person obtaining a copy of the Font Software, to use, study, copy, merge, embed, modify, redistribute, and sell modified and unmodified copies of the Font Software, subject to the following conditions:

1) Neither the Font Software nor any of its individual components, in Original or Modified Versions, may be sold by itself.
2) Original or Modified Versions of the Font Software may be bundled, redistributed and/or sold with any software, provided that each copy contains the above copyright notice and this license. These can be included either as stand-alone text files, human-readable headers or in the appropriate machine-readable metadata fields within text or binary files as long as those fields can be easily viewed by the user.
3) No Modified Version of the Font Software may use the Reserved Font Name(s) unless explicit written permission is granted by the corresponding Copyright Holder. This restriction only applies to the primary font name as presented to the users.
4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font Software shall not be used to promote, endorse or advertise any Modified Version, except to acknowledge the contribution(s) of the Copyright Holder(s) and the Author(s) or with their explicit written permission.
5) The Font Software, modified or unmodified, in part or in whole, must be distributed entirely under this license, and must not be distributed under any other license. The requirement for fonts to remain under this license does not apply to any document created using the Font Software.

TERMINATION
This license becomes null and void if any of the above conditions are not met.

DISCLAIMER
THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT OF COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE COPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, INCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL DAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM OTHER DEALINGS IN THE FONT SOFTWARE.

---

### GPL v2 Font Exception (Liberation Sans v1.05)

As a special exception, if you create a document which uses this font, and embed this font or unaltered portions of this font into the document, this font does not by itself cause the resulting document to be covered by the GNU General Public License. This exception does not however invalidate any other reasons why the document might be covered by the GNU General Public License. If you modify this font, you may extend this exception to your version of the font, but you are not obligated to do so. If you do not wish to do so, delete this exception statement from your version. (Full GNU GPL v2 text: `https://www.gnu.org/licenses/old-licenses/gpl-2.0.txt`)

---

### Unicode License v3 (`Unicode-3.0`)

COPYRIGHT AND PERMISSION NOTICE — Copyright © 1991-2025 Unicode, Inc.

NOTICE TO USER: Carefully read the following legal agreement. BY DOWNLOADING, INSTALLING, COPYING OR OTHERWISE USING DATA FILES, AND/OR SOFTWARE, YOU UNEQUIVOCALLY ACCEPT, AND AGREE TO BE BOUND BY, ALL OF THE TERMS AND CONDITIONS OF THIS AGREEMENT.

Permission is hereby granted, free of charge, to any person obtaining a copy of data files and any associated documentation (the "Data Files") or software and any associated documentation (the "Software") to deal in the Data Files or Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, and/or sell copies of the Data Files or Software, and to permit persons to whom the Data Files or Software are furnished to do so, provided that either (a) this copyright and permission notice appear with all copies of the Data Files or Software, or (b) this copyright and permission notice appear in associated Documentation.

THE DATA FILES AND SOFTWARE ARE PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT OF THIRD PARTY RIGHTS. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR HOLDERS INCLUDED IN THIS NOTICE BE LIABLE FOR ANY CLAIM, OR ANY SPECIAL INDIRECT OR CONSEQUENTIAL DAMAGES, OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THE DATA FILES OR SOFTWARE.
