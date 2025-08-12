const express = require('express');
const cors =require('cors');
const crypto = require('crypto'); // To generate UUIDs
const path = require('path');

// Using 'sqlite3' for an asynchronous, callback-based API
const sqlite3 = require('sqlite3').verbose();

// --- INITIAL CONFIGURATION ---
const app = express();
const PORT = 3001;

// Middlewares
app.use(cors());
app.use(express.json());

// --- DATABASE ---
// Points to a file 'estoque.db' in the same folder as server.js
const dbPath = path.resolve(__dirname, 'estoque.db');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error("Error connecting to the database:", err.message);
  } else {
    console.log("SQLite database connected successfully.");
    // Enables WAL mode for better performance and concurrency
    db.exec('PRAGMA journal_mode = WAL;', (err) => {
      if (err) {
        console.error("Error setting WAL mode:", err.message);
      }
    });
    setupDatabase();
  }
});


// Function to create tables if they don't exist
function setupDatabase() {
  const createTablesScript = `
    CREATE TABLE IF NOT EXISTS produtos (
      id TEXT PRIMARY KEY,
      sku TEXT UNIQUE NOT NULL,
      nome TEXT NOT NULL,
      descricao TEXT,
      categoria TEXT,
      unidade TEXT NOT NULL,
      quantidade INTEGER NOT NULL DEFAULT 0,
      estoqueMinimo INTEGER,
      localArmazenamento TEXT,
      fornecedor TEXT,
      criadoEm TEXT NOT NULL,
      atualizadoEm TEXT
    );

    CREATE TABLE IF NOT EXISTS movimentacoes (
      id TEXT PRIMARY KEY,
      produtoId TEXT NOT NULL,
      tipo TEXT NOT NULL,
      quantidade INTEGER NOT NULL,
      motivo TEXT,
      criadoEm TEXT NOT NULL,
      FOREIGN KEY (produtoId) REFERENCES produtos (id) ON DELETE CASCADE
    );
  `;

  // Executes the table creation script
  db.exec(createTablesScript, (err) => {
    if (err) {
      console.error("Error creating tables:", err.message);
    } else {
      console.log("Database tables verified.");
    }
  });
}

// --- HELPER FUNCTIONS ---
function uid() {
  return crypto.randomUUID();
}

function gerarSKU() {
  const skuPart = Math.random().toString(36).substring(2, 8).toUpperCase();
  return `PROD-${skuPart}`;
}

function nowISO() {
  return new Date().toISOString();
}


// --- API ROUTES ---

// GET: List all products
app.get('/api/produtos', (req, res) => {
  const sql = 'SELECT * FROM produtos ORDER BY nome ASC';
  db.all(sql, [], (err, rows) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    res.json(rows);
  });
});

// GET: List all movements
app.get('/api/movimentacoes', (req, res) => {
    const sql = 'SELECT * FROM movimentacoes ORDER BY criadoEm DESC';
    db.all(sql, [], (err, rows) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        res.json(rows);
    });
});

// POST: Create a new product
app.post('/api/produtos', (req, res) => {
  const { nome, descricao, categoria, unidade, quantidade, estoqueMinimo, localArmazenamento, fornecedor } = req.body;

  if (!nome || !unidade) {
    return res.status(400).json({ error: 'Name and Unit are mandatory.' });
  }

  const novoProduto = {
    id: uid(),
    sku: gerarSKU(),
    nome,
    descricao: descricao || null,
    categoria: categoria || null,
    unidade,
    quantidade: Number(quantidade) || 0,
    estoqueMinimo: Number(estoqueMinimo) || null,
    localArmazenamento: localArmazenamento || null,
    fornecedor: fornecedor || null,
    criadoEm: nowISO(),
    atualizadoEm: null,
  };

  const sql = `
    INSERT INTO produtos (id, sku, nome, descricao, categoria, unidade, quantidade, estoqueMinimo, localArmazenamento, fornecedor, criadoEm, atualizadoEm) 
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `;

  const params = [
    novoProduto.id, novoProduto.sku, novoProduto.nome, novoProduto.descricao, novoProduto.categoria,
    novoProduto.unidade, novoProduto.quantidade, novoProduto.estoqueMinimo, novoProduto.localArmazenamento,
    novoProduto.fornecedor, novoProduto.criadoEm, novoProduto.atualizadoEm
  ];

  db.run(sql, params, function(err) {
    if (err) {
      // Handles errors, like duplicate SKU
      return res.status(500).json({ error: err.message });
    }
    // Returns the complete object of the created product
    res.status(201).json(novoProduto);
  });
});

// PUT: Update an existing product
app.put('/api/produtos/:id', (req, res) => {
    const { id } = req.params;
    const patch = req.body;
    
    // Dynamically builds the update query
    const fields = Object.keys(patch).map(field => `${field} = ?`);
    const values = Object.values(patch);

    if (fields.length === 0) {
        return res.status(400).json({ error: 'No fields to update.' });
    }
    
    const sql = `UPDATE produtos SET ${fields.join(', ')}, atualizadoEm = ? WHERE id = ?`;
    const params = [...values, nowISO(), id];
    
    db.run(sql, params, function(err) {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        if (this.changes === 0) {
            return res.status(404).json({ error: 'Product not found.' });
        }
        res.status(200).json({ message: 'Product updated successfully.' });
    });
});

// DELETE: Delete a product
app.delete('/api/produtos/:id', (req, res) => {
    const { id } = req.params;
    // The foreign key with "ON DELETE CASCADE" will automatically remove associated movements.
    const sql = 'DELETE FROM produtos WHERE id = ?';
    
    db.run(sql, id, function(err) {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        if (this.changes === 0) {
            return res.status(404).json({ error: 'Product not found.' });
        }
        res.status(200).json({ message: 'Product and its movements have been deleted.' });
    });
});

// POST: Create a movement (with transaction for safety)
// --- ROTA ALTERADA ---
app.post('/api/movimentacoes', (req, res) => {
    const { produtoId, tipo, quantidade, motivo } = req.body;

    if (!produtoId || !tipo || !quantidade || Number(quantidade) <= 0) {
        return res.status(400).json({ error: 'Invalid movement data.' });
    }

    db.serialize(() => {
        db.run('BEGIN TRANSACTION;', (err) => {
            if (err) return res.status(500).json({ error: `Transaction start failed: ${err.message}` });
        });

        const getProductSql = 'SELECT * FROM produtos WHERE id = ?';
        db.get(getProductSql, [produtoId], (err, produto) => {
            if (err) {
                db.run('ROLLBACK;');
                return res.status(500).json({ error: err.message });
            }
            if (!produto) {
                db.run('ROLLBACK;');
                return res.status(404).json({ error: 'Product not found for movement.' });
            }

            let novaQuantidade;
            if (tipo === "ajuste") {
                novaQuantidade = Number(quantidade);
            } else {
                const delta = tipo === "entrada" ? Number(quantidade) : -Number(quantidade);
                novaQuantidade = produto.quantidade + delta;
            }
            novaQuantidade = Math.max(0, novaQuantidade);

            const updateSql = 'UPDATE produtos SET quantidade = ?, atualizadoEm = ? WHERE id = ?';
            db.run(updateSql, [novaQuantidade, nowISO(), produtoId], function(err) {
                if (err) {
                    db.run('ROLLBACK;');
                    return res.status(500).json({ error: `Product update failed: ${err.message}` });
                }

                const novaMov = {
                    id: uid(),
                    produtoId,
                    tipo,
                    quantidade: Number(quantidade),
                    motivo: motivo || null,
                    criadoEm: nowISO()
                };
                
                const insertMovSql = 'INSERT INTO movimentacoes (id, produtoId, tipo, quantidade, motivo, criadoEm) VALUES (?, ?, ?, ?, ?, ?)';
                db.run(insertMovSql, [novaMov.id, novaMov.produtoId, novaMov.tipo, novaMov.quantidade, novaMov.motivo, novaMov.criadoEm], function(err) {
                    if (err) {
                        db.run('ROLLBACK;');
                        return res.status(500).json({ error: `Movement creation failed: ${err.message}` });
                    }

                    db.run('COMMIT;', (err) => {
                        if (err) {
                            db.run('ROLLBACK;');
                            return res.status(500).json({ error: `Transaction commit failed: ${err.message}` });
                        }
                        
                        // --- ALTERAÇÃO INICIA AQUI ---
                        // Após o sucesso, busca o produto recém-atualizado para retorná-lo
                        const getUpdatedProductSql = 'SELECT * FROM produtos WHERE id = ?';
                        db.get(getUpdatedProductSql, [produtoId], (err, produtoAtualizado) => {
                            if (err) {
                                // A transação já foi comitada, mas retornamos apenas a movimentação como fallback
                                return res.status(201).json({ movimentacao: novaMov }); 
                            }
                            
                            // Responde com um objeto contendo a movimentação e o produto atualizado
                            res.status(201).json({ movimentacao: novaMov, produto: produtoAtualizado });
                        });
                        // --- ALTERAÇÃO TERMINA AQUI ---
                    });
                });
            });
        });
    });
});


// --- START THE SERVER ---
app.listen(PORT, () => {
  console.log(`🚀 Backend server running at http://localhost:${PORT}`);
});

// Graceful shutdown
process.on('SIGINT', () => {
    db.close((err) => {
        if (err) {
            return console.error(err.message);
        }
        console.log('Database connection closed.');
        process.exit(0);
    });
});